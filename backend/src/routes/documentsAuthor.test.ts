import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * 👤 #404 — АВТОР ФАЙЛА З CRM-АКАУНТА ПОКАЗУЄТЬСЯ ІМЕНЕМ, А НЕ ПОШТОЮ.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ, ХОЧ Є `#400j`. Той доводить, що запит ВИКОНУЄТЬСЯ і віддає
 * автора — і це справжня перевірка. Але його фікстура сіє РУЧНИЙ акаунт (`full_name`
 * заповнений, `manager_id` порожній), тобто приклад лише по ОДИН бік межі: на ньому
 * дворівневий `COALESCE(u.full_name, u.email)` і канонічний трирівневий
 * `COALESCE(m.name, u.full_name, u.email)` дають ОДНАКОВЕ значення. Правило 11:
 * фікстура з одного значення не перевіряє властивості. Тут — другий бік.
 *
 * 📐 І межа не теоретична, вона ЗАМІРЯНА на проді 14.09.2026:
 *     SELECT COUNT(*) FILTER (WHERE full_name IS NULL OR btrim(full_name)='')
 *       FROM users WHERE manager_id IS NOT NULL;   →  58 із 58
 * `users.full_name` за побудовою заповнюють лише ручним акаунтам — CRM-менеджерам
 * ПІБ живе в `managers.name` (коментар до колонки в `schema.sql`). Тобто КОЖЕН
 * менеджер, який заллє файл, показався б поштою.
 * ⚠️ Сьогодні цього ще не видно: у базі 2 файли одного не-CRM автора. Стане видно з
 * першим же файлом від менеджера — тобто рівно тоді, коли розділом почнуть
 * користуватись за призначенням.
 *
 * 🧨 САБОТАЖ: у `documents.ts` замінити `COALESCE(m.name, u.full_name, u.email)` на
 * `COALESCE(u.full_name, u.email)` → автор приїде поштою, гейт червоніє.
 */
test("#404 автор файла з CRM-акаунта — імʼя з managers, а не пошта", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    // 🔴 САМЕ ТАКИЙ АКАУНТ І Є НА ПРОДІ 58 РАЗІВ: привʼязаний до CRM, `full_name` порожній.
    await c.query(`INSERT INTO managers (id,name,is_active) VALUES (7,'Юлія Лисенко',true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,full_name)
                   VALUES (1,'yuliia@uts.ua','x','admin',7,NULL)`);
    await c.query(`INSERT INTO doc_folders (id,parent_id,name,created_by) VALUES (1,NULL,'Регламенти',1)`);
    await c.query(`INSERT INTO doc_files (folder_id,name,stored_name,category,mime,size_bytes,created_by)
                   VALUES (1,'Регламент проведення зустрічі.pdf','uuid.pdf','Регламент','application/pdf',2048,1)`);

    const { documentsRouter } = await import("./documents.js");
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layer = (documentsRouter as unknown as { stack: Layer[] }).stack
      .find((l) => l.route?.path === "/tree" && l.route.methods.get);
    assert.ok(layer, "🔴 роут GET /tree зник — гейт втратив предмет");
    const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
      (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;

    let code = 200;
    let payload: unknown;
    const res = {
      status(x: number) { code = x; return res; },
      json(b: unknown) { payload = b; return res; },
    };
    let thrown: unknown = null;
    await handler({ auth: { userId: 1, role: "admin", roleKey: "admin", managerId: 7, teamId: null }, query: {} },
      res, (e?: unknown) => { if (e) thrown = e; }).catch((e) => { thrown = e; });

    assert.equal(thrown, null,
      `🔴 GET /documents/tree ВПАВ: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    assert.equal(code, 200, `віддав ${code}`);
    const body = payload as { files: { author: string }[] };
    assert.equal(body.files.length, 1, "файл не повернувся — нема чого перевіряти");
    assert.equal(body.files[0].author, "Юлія Лисенко",
      "🔴 автор приїхав НЕ іменем із `managers`. Так на екрані стоятиме пошта — "
      + "для всіх 58 CRM-акаунтів прода, тобто для кожного, хто реально заливає файли");
    assert.ok(!/@/.test(body.files[0].author),
      `🔴 у полі автора пошта («${body.files[0].author}») — трирівневий COALESCE зник`);

    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => {});
  } finally {
    await c.end().catch(() => {});
    scratch.dispose();
  }
});
