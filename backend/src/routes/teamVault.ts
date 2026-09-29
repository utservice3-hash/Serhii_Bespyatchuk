import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { parseKey, SecretKeyMissing } from "../core/secretBox.js";
import { SecretError, type Db, sendRevealCode, revealSecret, vaultLinkState, createVaultLink, unlinkVault } from "../core/secrets.js";
import { listTeamPeople, teamPersonVault, assertTeamSecret, resetTeamPassword } from "../core/teamVault.js";
import { vaultBotConfigured, vaultBotSend, vaultBotUsername } from "../bot/vaultBot.js";

/**
 * 👥 «НАЙМ → СПІВРОБІТНИКИ» ДЛЯ ТІМЛІДА (29.09.2026): люди своєї команди, їхні паролі й пароль дашборда.
 *
 * Дві межі на рівні РОУТЕРА (забути в новому роуті неможливо): tab-гейт `pre("/api/team-vault")` →
 * вкладка `hiring` і право `view_team_secrets` (видане лише `team_lead`). Третя межа — у КОЖНОМУ
 * обробнику, першим значущим оператором: `teamMemberVerdict` через `core/teamVault.ts` (своя команда
 * за CRM, лише менеджери, не сам тімлід). Значення виходить лише з `reveal` (код у Telegram) і
 * з `reset-password` (новий пароль, один раз). Тримають `#981`–`#984`.
 */
export const teamVaultRouter = Router();
teamVaultRouter.use(requireAuth, requirePerm("view_team_secrets"));

const key = () => parseKey(process.env.EMPLOYEE_SECRETS_KEY);
const sender = () => (vaultBotConfigured() ? vaultBotSend : null);
const me = (req: Request) => req.auth!.userId;
const db = () => pool as unknown as Db;

function fail(res: Response, e: unknown) {
  if (e instanceof SecretKeyMissing) return res.status(503).json({ error: e.message });
  if (e instanceof SecretError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  // 🔴 Тіло помилки НЕ логуємо: у відповіді може бути пароль.
  console.error("[team-vault]", (e as Error)?.message ?? "error");
  return res.status(500).json({ error: "Помилка сервера" });
}

async function tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client as unknown as Db);
    await client.query("COMMIT");
    return out;
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}

const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new SecretError(400, `Некоректний ${what}`);
  return n;
};

teamVaultRouter.get("/status", async (req, res) => {
  try {
    const link = await vaultLinkState(db(), me(req));
    res.json({ keyConfigured: key() != null, botConfigured: vaultBotConfigured(),
      botUsername: vaultBotConfigured() ? await vaultBotUsername() : null, linked: link.linked, linkedAt: link.linkedAt });
  } catch (e) { fail(res, e); }
});

teamVaultRouter.post("/link", async (req, res) => {
  try {
    if (!vaultBotConfigured()) throw new SecretError(503, "Бот «UTS Сейф» не налаштований на сервері");
    const username = await vaultBotUsername();
    const r = await createVaultLink(db(), me(req));
    res.json({ code: r.code, expiresInSec: r.expiresInSec, botUsername: username, url: username ? `https://t.me/${username}?start=${r.code}` : null });
  } catch (e) { fail(res, e); }
});

teamVaultRouter.post("/unlink", async (req, res) => {
  try { await unlinkVault(db(), me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

teamVaultRouter.get("/people", async (req, res) => {
  try { res.json(await listTeamPeople(db(), me(req))); } catch (e) { fail(res, e); }
});

teamVaultRouter.get("/people/:userId", async (req, res) => {
  try { res.json(await teamPersonVault(db(), me(req), num(req.params.userId, "id людини"))); } catch (e) { fail(res, e); }
});

teamVaultRouter.post("/:id/code", async (req, res) => {
  try {
    const id = num(req.params.id, "id запису");
    res.json(await tx(async (d) => { await assertTeamSecret(d, me(req), id); return sendRevealCode(d, me(req), id, sender()); }));
  } catch (e) { fail(res, e); }
});

/** 🔴 Звідси виходить значення. Кешувати відповідь заборонено. */
teamVaultRouter.post("/:id/reveal", async (req, res) => {
  try {
    const id = num(req.params.id, "id запису");
    const out = await tx(async (d) => { await assertTeamSecret(d, me(req), id); return revealSecret(d, key(), me(req), id, req.body ?? {}); });
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) { fail(res, e); }
});

/** 🔴 Новий пароль дашборда — у відповіді ОДИН раз, далі лише через показ із кодом. */
teamVaultRouter.post("/people/:userId/reset-password", async (req, res) => {
  try {
    const userId = num(req.params.userId, "id людини");
    const out = await tx((d) => resetTeamPassword(d, key(), me(req), userId));
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) { fail(res, e); }
});
