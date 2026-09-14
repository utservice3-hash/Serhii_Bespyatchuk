import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #399j — ДЕРЕВО ДОКУМЕНТІВ ВИКОНУЄТЬСЯ, А НЕ «ПРОСТО ВІДПОВІДАЄ».
 *
 * 🔴 ПРИВІД ЗАМІРЯНИЙ, А НЕ ГІПОТЕТИЧНИЙ. `GET /api/documents/tree` віддавав **500**
 * на проді, і вкладка «Регламенти та документи» не працювала ні для кого. Причина
 * (замір 14.09.2026 проти прод-БД): `COALESCE(u.name, u.email)` — а колонки `name`
 * у `users` НЕМАЄ, є `full_name`. Сусідній роут задач увесь час стояв із
 * `cu.full_name`: правильний зразок лежав поруч.
 *
 * ⚠️ ЧОМУ ЦЕ ПРОЖИЛО ДОВГО І ЧОМУ ГЕЙТ МУСИТЬ ВИКОНУВАТИ ЗАПИТ:
 *  • `tsc` SQL у шаблонному рядку не типізує взагалі;
 *  • матриця доступу (`#11`) питає лише «403 чи не 403» — для неї 500 це
 *    ПРОЙДЕНИЙ гейт, тобто зелена клітинка;
 *  • `test:prod` перевіряє, що ендпоінт живий, а не що він віддав дані.
 * Отже жодна наявна перевірка не могла цього побачити. Ловить лише виконання.
 *
 * 🔴 І ДРУГА ПОЛОВИНА, БЕЗ ЯКОЇ ГЕЙТ БУВ БИ ПІВСПРАВОЮ: екран показував 500 і
 * «Порожньо. Створіть папку або завантажте файл» ОДНОЧАСНО. Людина читає спокійніше
 * повідомлення й робить хибний висновок — той самий клас, що коштував нам пʼяти
 * тижнів на планах клієнтів. Тому тут перевіряється не лише код 200, а й що у
 * відповіді СПРАВДІ є рядок із автором.
 *
 * 🧨 Червоніє, якщо повернути будь-яку неіснуючу колонку в цей запит.
 */
test("#399j ДЕРЕВО ДОКУМЕНТІВ: запит виконується проти бази з нуля й віддає автора", async (t) => {
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
    await c.query(`INSERT INTO users (id,email,password_hash,role,full_name)
                   VALUES (1,'kvp@uts.ua','x','admin','Керівник КВП')`);
    await c.query(`INSERT INTO doc_folders (id,parent_id,name,created_by) VALUES (1,NULL,'Регламенти',1)`);
    await c.query(`INSERT INTO doc_files (folder_id,name,stored_name,category,mime,size_bytes,created_by)
                   VALUES (1,'Регламент зустрічі.pdf','uuid.pdf','Регламент','application/pdf',1024,1)`);

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
    // 🔴 Помилку ловимо САМІ. Обробник не має `try/catch`, тож у застосунку вона
    // летить в error-middleware, який завжди віддає 500 «internal error» —
    // саме тому текст справжньої причини ніхто й не бачив.
    let thrown: unknown = null;
    await handler({ auth: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null }, query: {} },
      res, (e?: unknown) => { if (e) thrown = e; }).catch((e) => { thrown = e; });

    assert.equal(thrown, null,
      `🔴 GET /documents/tree ВПАВ: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    assert.equal(code, 200, `віддав ${code}`);
    const body = payload as { folders: unknown[]; files: { author: string }[] };
    assert.equal(body.folders.length, 1, "папка не повернулась");
    assert.equal(body.files.length, 1, "файл не повернувся");
    assert.equal(body.files[0].author, "Керівник КВП",
      "🔴 автор файла не доїхав — саме тут стояла неіснуюча колонка `u.name`");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});
