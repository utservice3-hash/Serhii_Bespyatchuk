import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { parseKey, SecretKeyMissing } from "../core/secretBox.js";
import {
  SecretError, type Db, listPeople, personVault, createSecret, updateSecret, setSecretDeleted,
  sendRevealCode, revealSecret, vaultLinkState, createVaultLink, unlinkVault,
} from "../core/secrets.js";
import { previewImport, commitImport, listEmployees, ImportError } from "../core/employees.js";
import { vaultBotConfigured, vaultBotSend, vaultBotUsername } from "../bot/vaultBot.js";

/**
 * 🔐 СЕЙФ ДОСТУПІВ СПІВРОБІТНИКІВ (18.09.2026).
 *
 * Дві межі, обидві на рівні РОУТЕРА, а не обробника — забути їх у новому роуті неможливо:
 *  1. tab-гейт `pre("/api/secrets")` → вкладка `hiring` (сейф живе в «Наймі» → «Доступи»);
 *  2. право `view_employee_secrets` — рівно пʼять ролей: admin, ceo, opdir, kvp, hr (рішення Романа).
 * Тримає `#553`. Значення виходить лише з `POST /:id/reveal` після коду з Telegram «UTS Сейф».
 */
export const secretsRouter = Router();
secretsRouter.use(requireAuth, requirePerm("view_employee_secrets"));

/** Ключ читаємо щоразу з оточення: без нього сейф відповідає 503, а сервер живе далі (`#555`). */
const key = () => parseKey(process.env.EMPLOYEE_SECRETS_KEY);
const sender = () => (vaultBotConfigured() ? vaultBotSend : null);

function fail(res: Response, e: unknown) {
  if (e instanceof SecretKeyMissing) return res.status(503).json({ error: e.message });
  if (e instanceof ImportError) return res.status(e.status).json({ error: e.message });
  if (e instanceof SecretError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  // 🔴 Тіло помилки НЕ логуємо: у запиті може бути пароль.
  console.error("[secrets]", (e as Error)?.message ?? "error");
  return res.status(500).json({ error: "Помилка сервера" });
}

async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
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
const me = (req: Request) => req.auth!.userId;

secretsRouter.get("/status", async (req, res) => {
  try {
    const link = await vaultLinkState(pool as unknown as Db, me(req));
    res.json({ keyConfigured: key() != null, botConfigured: vaultBotConfigured(),
      botUsername: vaultBotConfigured() ? await vaultBotUsername() : null, linked: link.linked, linkedAt: link.linkedAt });
  } catch (e) { fail(res, e); }
});

secretsRouter.post("/link", async (req, res) => {
  try {
    if (!vaultBotConfigured()) throw new SecretError(503, "Бот «UTS Сейф» не налаштований на сервері");
    const username = await vaultBotUsername();
    const r = await createVaultLink(pool as unknown as Db, me(req));
    res.json({ code: r.code, expiresInSec: r.expiresInSec, botUsername: username, url: username ? `https://t.me/${username}?start=${r.code}` : null });
  } catch (e) { fail(res, e); }
});

secretsRouter.post("/unlink", async (req, res) => {
  try { await unlinkVault(pool as unknown as Db, me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

secretsRouter.get("/people", async (_req, res) => {
  try { res.json({ rows: await listPeople(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});

// `:userId` — id акаунта («12») або людини реєстру без акаунта («e34»); розбирає `parseRef`.
secretsRouter.get("/people/:userId", async (req, res) => {
  try { res.json(await personVault(pool as unknown as Db, req.params.userId)); } catch (e) { fail(res, e); }
});

secretsRouter.post("/people/:userId", async (req, res) => {
  try {
    const id = await tx((db) => createSecret(db, key(), me(req), req.params.userId, req.body ?? {}));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});

secretsRouter.patch("/:id", async (req, res) => {
  try {
    const id = await tx((db) => updateSecret(db, key(), me(req), num(req.params.id, "id запису"), req.body ?? {}));
    res.json({ id });
  } catch (e) { fail(res, e); }
});

secretsRouter.delete("/:id", async (req, res) => {
  try { await tx((db) => setSecretDeleted(db, me(req), num(req.params.id, "id запису"), true)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

secretsRouter.post("/:id/restore", async (req, res) => {
  try { await tx((db) => setSecretDeleted(db, me(req), num(req.params.id, "id запису"), false)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

secretsRouter.post("/:id/code", async (req, res) => {
  try { res.json(await tx((db) => sendRevealCode(db, me(req), num(req.params.id, "id запису"), sender()))); } catch (e) { fail(res, e); }
});

/** 🔴 Єдине місце, звідки виходить значення. Кешувати відповідь заборонено. */
secretsRouter.post("/:id/reveal", async (req, res) => {
  try {
    const out = await tx((db) => revealSecret(db, key(), me(req), num(req.params.id, "id запису"), req.body ?? {}));
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) { fail(res, e); }
});

/*
 * 🗂 РЕЄСТР СПІВРОБІТНИКІВ + ІМПОРТ ТАБЛИЦІ (18.09.2026, задача №3898). Тут, а не окремим роутером:
 * імпорт кладе паролі в сейф, тож межа та сама — `view_employee_secrets` на роутері вище.
 * Прев'ю НІЧОГО не пише і не віддає значень секретів; імпорт — одна транзакція.
 */
secretsRouter.get("/employees", async (_req, res) => {
  try { res.json({ rows: await listEmployees(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});

secretsRouter.post("/import/preview", async (req, res) => {
  try { res.json(await previewImport(pool as unknown as Db, req.body?.csv, req.body?.mapping, req.body?.headerRow)); } catch (e) { fail(res, e); }
});

secretsRouter.post("/import/commit", async (req, res) => {
  try {
    const counts = await tx((db) => commitImport(db, key(), me(req), req.body?.csv, req.body?.mapping, req.body?.sheet, req.body?.headerRow));
    res.json({ ok: true, counts });
  } catch (e) { fail(res, e); }
});
