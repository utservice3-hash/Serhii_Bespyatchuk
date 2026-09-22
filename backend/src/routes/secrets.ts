import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { parseKey, SecretKeyMissing } from "../core/secretBox.js";
import {
  SecretError, type Db, listPeople, personVault, createSecret, updateSecret, setSecretDeleted,
  sendRevealCode, revealSecret, vaultLinkState, createVaultLink, unlinkVault,
} from "../core/secrets.js";
import { previewImport, commitImport, listEmployees, updateEmployee, ImportError } from "../core/employees.js";
import { createEmployee, matchFiles } from "../core/employeeAdd.js";
import { startDismissal, finishDismissal, revertDismissal } from "../core/offboarding.js";
import { listEmployeeDocs, employeeDoc, attachEmployeeDoc, setEmployeeDocDeleted } from "../core/employeeDocs.js";
import { isManagement } from "../core/docAccess.js";
import { UPLOAD_DIR } from "./uploads.js";
import { randomUUID, createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { churnReport, linkKommo, listExits, createExit, updateExit, setExitDeleted, ChurnError } from "../core/churn.js";
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
  if (e instanceof ImportError) return res.status(e.status).json({ error: e.message, ...("existingId" in e ? { existingId: (e as { existingId?: number }).existingId } : {}) });
  if (e instanceof ChurnError) return res.status(e.status).json({ error: e.message });
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
  try {
    const db = pool as unknown as Db;
    // Команди для фільтра й зміни: що є в реєстрі + команди дашборда.
    const teams = (await db.query<{ name: string }>(
      `SELECT DISTINCT name FROM (SELECT team_label AS name FROM employees WHERE team_label IS NOT NULL
         UNION SELECT name FROM teams WHERE name IS NOT NULL) t ORDER BY name`)).rows.map((r) => r.name);
    res.json({ rows: await listEmployees(db), teams });
  } catch (e) { fail(res, e); }
});

/* 👤 «+ Співробітник» і 📎 розкладання файлів пакета по людях (22.09.2026) — `core/employeeAdd.ts`. */
secretsRouter.post("/employees", async (req, res) => {
  try { res.status(201).json(await tx((db) => createEmployee(db, me(req), req.body ?? {}))); } catch (e) { fail(res, e); }
});
secretsRouter.post("/employees/documents/match", async (req, res) => {
  try { res.json({ rows: await matchFiles(pool as unknown as Db, req.body?.files) }); } catch (e) { fail(res, e); }
});

secretsRouter.patch("/employees/:id", async (req, res) => {
  try {
    const r = await tx((db) => updateEmployee(db, me(req), num(req.params.id, "id співробітника"), req.body ?? {}));
    res.json({ ok: true, changed: r.changed });
  } catch (e) { fail(res, e); }
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

/*
 * 🚪 ЗВІЛЬНЕННЯ У ДВА КРОКИ (21.09.2026) — правило в `core/offboarding.ts`. Межа та сама, що в реєстру.
 */
secretsRouter.post("/employees/:id/dismiss", async (req, res) => {
  try { res.json(await tx((db) => startDismissal(db, me(req), num(req.params.id, "id співробітника"), req.body ?? {}))); } catch (e) { fail(res, e); }
});
secretsRouter.post("/employees/:id/dismiss/finish", async (req, res) => {
  try { res.json(await tx((db) => finishDismissal(db, me(req), num(req.params.id, "id співробітника")))); } catch (e) { fail(res, e); }
});
secretsRouter.post("/employees/:id/dismiss/revert", async (req, res) => {
  try { res.json(await tx((db) => revertDismissal(db, me(req), num(req.params.id, "id співробітника")))); } catch (e) { fail(res, e); }
});

/*
 * 📎 ДОКУМЕНТИ ЛЮДИНИ (21.09.2026) — правило в `core/employeeDocs.ts`. Поверх межі роутера ще й «керівництво»
 * модуля «Документи»: право `view_employee_secrets` видають ролям, але чужі особисті документи бачить лише
 * керівництво — і ця межа не мусить залежати від того, кому колись видадуть сейф.
 */
const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents"); // та сама тека, що в `routes/documents.ts`, і під нічним бекапом
const docStore = async (display: string, buf: Buffer) => {
  const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
  const storedName = `${randomUUID()}${ext}`;
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, storedName), buf);
  return { storedName, sha256: createHash("sha256").update(buf).digest("hex") };
};
const onlyManagement = (req: Request) => {
  if (!isManagement(req.auth!.roleKey)) throw new ImportError(403, "Документи людей — лише керівництву");
};
const b64 = (v: unknown) => (typeof v === "string" && v ? Buffer.from(v.includes(",") ? v.split(",")[1] : v, "base64") : null);

secretsRouter.get("/employees/:id/documents", async (req, res) => {
  try { onlyManagement(req); res.json({ files: await listEmployeeDocs(pool as unknown as Db, num(req.params.id, "id співробітника")) }); } catch (e) { fail(res, e); }
});
secretsRouter.post("/employees/:id/documents", async (req, res) => {
  try {
    onlyManagement(req);
    const r = await tx((db) => attachEmployeeDoc(db, me(req), num(req.params.id, "id співробітника"),
      { filename: req.body?.filename, mime: req.body?.mime, kind: req.body?.kind, buffer: b64(req.body?.dataBase64) }, docStore));
    res.status(201).json(r);
  } catch (e) { fail(res, e); }
});
secretsRouter.get("/employees/:id/documents/:fileId", async (req, res) => {
  try {
    onlyManagement(req);
    const f = await employeeDoc(pool as unknown as Db, num(req.params.id, "id співробітника"), num(req.params.fileId, "id документа"));
    if (f.deleted_at) throw new ImportError(404, "Документ прибрано — поверніть його, щоб відкрити");
    if (f.mime) res.type(f.mime);
    res.setHeader("Content-Disposition", `${String(req.query.inline ?? "") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(path.join(DOCS_DIR, f.stored_name), (err) => { if (err && !res.headersSent) res.status(404).json({ error: "Файл на диску не знайдено" }); });
  } catch (e) { fail(res, e); }
});
secretsRouter.delete("/employees/:id/documents/:fileId", async (req, res) => {
  try { onlyManagement(req); await tx((db) => setEmployeeDocDeleted(db, me(req), num(req.params.id, "id співробітника"), num(req.params.fileId, "id документа"), true)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
secretsRouter.post("/employees/:id/documents/:fileId/restore", async (req, res) => {
  try { onlyManagement(req); await tx((db) => setEmployeeDocDeleted(db, me(req), num(req.params.id, "id співробітника"), num(req.params.fileId, "id документа"), false)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

/*
 * 📉 ПЛИННІСТЬ, EXIT-ІНТЕРВʼЮ, ПРИВʼЯЗКА ДО KOMMO (етапи 4–5, 18.09.2026). Та сама межа, що й реєстр:
 * звільнення й відповіді звільнених — персональні дані.
 */
secretsRouter.get("/churn", async (req, res) => {
  try { res.json(await churnReport(pool as unknown as Db, req.query.from, req.query.to)); } catch (e) { fail(res, e); }
});

secretsRouter.post("/employees/kommo-link", async (_req, res) => {
  try { res.json(await tx((db) => linkKommo(db))); } catch (e) { fail(res, e); }
});

secretsRouter.get("/exit", async (_req, res) => {
  try { res.json(await listExits(pool as unknown as Db)); } catch (e) { fail(res, e); }
});

secretsRouter.post("/exit", async (req, res) => {
  try { res.status(201).json({ id: await tx((db) => createExit(db, me(req), req.body ?? {})) }); } catch (e) { fail(res, e); }
});

secretsRouter.patch("/exit/:id", async (req, res) => {
  try { await tx((db) => updateExit(db, num(req.params.id, "id інтервʼю"), req.body ?? {})); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

secretsRouter.delete("/exit/:id", async (req, res) => {
  try { await tx((db) => setExitDeleted(db, num(req.params.id, "id інтервʼю"), true)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

secretsRouter.post("/exit/:id/restore", async (req, res) => {
  try { await tx((db) => setExitDeleted(db, num(req.params.id, "id інтервʼю"), false)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
