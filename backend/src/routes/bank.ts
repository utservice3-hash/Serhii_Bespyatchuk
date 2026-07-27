import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasPerm } from "../auth/rbac.js";
import { writeAudit } from "../db/audit.js";
import { incoming, outgoing, getHiddenPayees, type BankFilter } from "../core/bankReport.js";

export const bankRouter = Router();
bankRouter.use(requireAuth); // tab-гейт «bank» — усі ролі (screen_access); + auto-asyncH через lib/asyncRoutes

const filterFrom = (q: Record<string, unknown>): BankFilter => ({
  from: q.from ? String(q.from) : undefined,
  to: q.to ? String(q.to) : undefined,
  company: q.company ? String(q.company) : undefined,
  account: q.account ? Number(q.account) : undefined,
  currency: q.currency ? String(q.currency) : undefined,
  q: q.q ? String(q.q) : undefined,
});
const audit = (req: import("express").Request) => ({ actorUserId: req.auth!.userId, actorEmail: req.auth!.email ?? null });

// Вхідні — усі ролі, повний обсяг.
bankRouter.get("/incoming", async (req, res) => {
  res.json(await incoming(filterFrom(req.query as Record<string, unknown>)));
});

// Вихідні — усі ролі; приховані рядки СЕРВЕРНО виключаються без права view_hidden_payments.
bankRouter.get("/outgoing", async (req, res) => {
  const canSeeHidden = roleHasPerm(req.auth!.roleKey, "view_hidden_payments");
  const payees = await getHiddenPayees();
  const data = await outgoing(filterFrom(req.query as Record<string, unknown>), payees, canSeeHidden);
  res.json({ ...data, canSeeHidden });
});

// Дебіторка по компаніях — відкладено (варіант «в»): placeholder, без вигаданого розрізу.
bankRouter.get("/receivables", async (_req, res) => {
  res.json({ deferred: true, message: "Розріз дебіторки по юрособах — скоро (потрібна ознака юрособи)" });
});

// Реєстр рахунків + реквізити (усі ролі — для чипів фільтра). api_connected — похідне.
// env_key_name (НАЗВА змінної, не ключ) віддаємо лише тим, хто керує рахунками. Значення ключа — НІКОЛИ.
bankRouter.get("/accounts", async (req, res) => {
  const canManage = roleHasPerm(req.auth!.roleKey, "manage_bank_accounts");
  const r = await pool.query(
    `SELECT id, company, bank, label, currency, external_account_id, is_active,
            legal_name, edrpou_ipn, iban, bank_name, mfo, purpose, env_key_name
       FROM bank_accounts ORDER BY is_active DESC, label`);
  const accounts = r.rows.map((a) => ({
    ...a,
    api_connected: !!(a.env_key_name && process.env[a.env_key_name]),
    env_key_name: canManage ? a.env_key_name : undefined, // назва лише для панелі; значення — ніколи
  }));
  res.json({ accounts });
});

// --- Мутації реквізитів (право manage_bank_accounts) ---
bankRouter.post("/accounts", requirePerm("manage_bank_accounts"), async (req, res) => {
  const b = req.body ?? {};
  if (!["uts", "automuv", "fop_privat", "fop_mono"].includes(b.company)) return res.status(400).json({ error: "Невірна company" });
  if (!["mono", "privat"].includes(b.bank)) return res.status(400).json({ error: "Невірний bank" });
  if (!String(b.label ?? "").trim()) return res.status(400).json({ error: "Потрібна назва (label)" });
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO bank_accounts (company,bank,label,currency,external_account_id,is_active,legal_name,edrpou_ipn,iban,bank_name,mfo,purpose,env_key_name)
     VALUES ($1,$2,$3,COALESCE($4,'UAH'),$5,COALESCE($6,true),$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [b.company, b.bank, String(b.label).trim(), b.currency, b.externalAccountId ?? null, b.isActive,
     b.legalName ?? null, b.edrpouIpn ?? null, b.iban ?? null, b.bankName ?? null, b.mfo ?? null, b.purpose ?? null, b.envKeyName ?? null]);
  await writeAudit({ ...audit(req), action: "bank.account.create", targetType: "bank_account", targetId: String(ins.rows[0].id), targetLabel: String(b.label) });
  res.json({ ok: true, id: ins.rows[0].id });
});

bankRouter.patch("/accounts/:id", requirePerm("manage_bank_accounts"), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const map: Record<string, string> = { label: "label", currency: "currency", externalAccountId: "external_account_id",
    isActive: "is_active", legalName: "legal_name", edrpouIpn: "edrpou_ipn", iban: "iban", bankName: "bank_name", mfo: "mfo", purpose: "purpose", envKeyName: "env_key_name" };
  const sets: string[] = []; const params: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in b) { params.push(b[k]); sets.push(`${col} = $${params.length}`); }
  if (!sets.length) return res.json({ ok: true });
  params.push(id);
  const r = await pool.query(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING label`, params);
  if (!r.rows[0]) return res.status(404).json({ error: "Рахунок не знайдено" });
  await writeAudit({ ...audit(req), action: "bank.account.update", targetType: "bank_account", targetId: String(id), targetLabel: r.rows[0].label, details: { fields: Object.keys(b) } });
  res.json({ ok: true });
});

bankRouter.delete("/accounts/:id", requirePerm("manage_bank_accounts"), async (req, res) => {
  const id = Number(req.params.id);
  const used = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM bank_transactions WHERE account_id=$1`, [id]);
  if (used.rows[0].n > 0) return res.status(409).json({ error: "Є історія транзакцій — вимкніть рахунок (is_active=false), не видаляйте" });
  const r = await pool.query<{ label: string }>(`DELETE FROM bank_accounts WHERE id=$1 RETURNING label`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Рахунок не знайдено" });
  await writeAudit({ ...audit(req), action: "bank.account.delete", targetType: "bank_account", targetId: String(id), targetLabel: r.rows[0].label });
  res.json({ ok: true });
});

// --- Приховані отримувачі (право manage_bank_hidden) ---
bankRouter.get("/hidden-payees", requirePerm("manage_bank_hidden"), async (_req, res) => {
  const r = await pool.query(`SELECT id, pattern, match_type, note, created_at FROM bank_hidden_payees ORDER BY id`);
  res.json({ payees: r.rows });
});

bankRouter.post("/hidden-payees", requirePerm("manage_bank_hidden"), async (req, res) => {
  const pattern = String(req.body?.pattern ?? "").trim();
  const matchType = req.body?.matchType === "glob" ? "glob" : "exact";
  if (!pattern) return res.status(400).json({ error: "Потрібен шаблон" });
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO bank_hidden_payees (pattern, match_type, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [pattern, matchType, req.body?.note ?? null, req.auth!.userId]);
  await writeAudit({ ...audit(req), action: "bank.hidden.add", targetType: "bank_payee", targetId: String(ins.rows[0].id), targetLabel: pattern, details: { matchType } });
  res.json({ ok: true, id: ins.rows[0].id });
});

bankRouter.delete("/hidden-payees/:id", requirePerm("manage_bank_hidden"), async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query<{ pattern: string }>(`DELETE FROM bank_hidden_payees WHERE id=$1 RETURNING pattern`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Не знайдено" });
  await writeAudit({ ...audit(req), action: "bank.hidden.remove", targetType: "bank_payee", targetId: String(id), targetLabel: r.rows[0].pattern });
  res.json({ ok: true });
});
