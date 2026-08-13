import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #76 — СИНК ЗАДАЧ KOMMO.
 *
 * Задачі — четверте джерело активності, і найважче: **79%** активних FC-угод мають
 * задачу за 14 днів, **499** із них не мають більше нічого. Помилка тут не ламає
 * екран — вона робить критерій застрягання сліпим, і побачити це буде ніяк.
 *
 * Три речі, кожна з яких коштувала б реальних угод:
 *   #76  — інкремент по `updated_at`, а не `created_at` (52 угоди);
 *   #76b — збій порції не перестрибує невичитане (пастка «все або нічого»);
 *   #76c — `text`/`result` НЕ зберігаються (персональні дані);
 *   #76d — збережено ОБОХ акторів (204 угоди);
 *   #76e — upsert ідемпотентний і оновлює стан задачі.
 */

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const src = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

test("#76 ІНКРЕМЕНТ ПО updated_at, а не created_at", () => {
  const client = src("kommo/client.ts");
  const fn = client.slice(client.indexOf("export async function forEachTaskPage"),
    client.indexOf("export async function forEachStatusChangeEventPage"));
  assert.ok(fn.length > 200, "🔴 forEachTaskPage зник — перевіряти нема чого");
  assert.ok(fn.includes("filter[updated_at][from]") && fn.includes("filter[updated_at][to]"),
    "🔴 вікно будується не по updated_at");
  assert.ok(!fn.includes("filter[created_at]"),
    "🔴 у вікні зʼявився created_at — закриття старої задачі перестане бути видимим "
    + "(заміряно: 76 таких задач за 14 днів, 52 активні угоди)");

  const job = src("jobs/syncKommoTasks.ts");
  assert.ok(job.includes("last_task_at"), "🔴 джоба не веде власного вотермарка");
  assert.ok(!/last_event_at|last_activity_note_at/.test(job),
    "🔴 джоба чіпає ЧУЖИЙ вотермарк — два джерела на одну колонку розійдуться мовчки");
});

test("#76b ПОРЦІЇ: збій не перестрибує невичитане", () => {
  const job = src("jobs/syncKommoTasks.ts");
  assert.ok(job.includes("processInChunks"),
    "🔴 джоба не йде порціями — один збій за десятки сторінок втратить увесь прогрес "
    + "(так замерзли три вотермарки на IP-бані 08.07)");
  // Вотермарк рухається ПІСЛЯ порції, і лише в інкременті.
  // ⚠️ САМЕ ВИКЛИК, а не імпорт: перша редакція брала `indexOf("processInChunks")`,
  //    що вказує на рядок import угорі файла, і вікно накривало коментар замість коду.
  const idx = job.indexOf("await processInChunks(");
  assert.ok(idx > 0, "🔴 виклику processInChunks у джобі немає");
  const call = job.slice(idx, idx + 700);
  assert.ok(/isBackfill\s*\n?\s*\?\s*null/.test(call),
    "🔴 бекфіл рухає вотермарк — він перестрибнув би невичитане свіже вікно");
  assert.ok(call.includes("UPDATE sync_state SET last_task_at"),
    "🔴 вотермарк не рухається після порції — інкремент перечитуватиме одне й те саме");
});

test("#76c text/result НЕ ЗБЕРІГАЮТЬСЯ — ні в схемі, ні у вставці", () => {
  const schema = readFileSync(SCHEMA, "utf8");
  const tbl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS kommo_tasks"),
    schema.indexOf("idx_kommo_tasks_entity"));
  assert.ok(tbl.length > 200, "🔴 таблиці kommo_tasks у схемі немає");
  for (const col of ["text", "result"])
    assert.ok(!new RegExp(`^\\s+${col}\\s`, "m").test(tbl),
      `🔴 у kommo_tasks зʼявилась колонка «${col}» — це вільний текст менеджера про `
      + "клієнта, тобто персональні дані, яких критерій не потребує");

  const job = src("jobs/syncKommoTasks.ts");
  // ⚠️ Перевіряємо СПИСОК КОЛОНОК, а не весь текст запиту: `::text[]` — це каст
  //    типу, і наївний `includes("text")` червонів на ньому (спіймано одразу).
  const insHead = job.slice(job.indexOf("INSERT INTO kommo_tasks"), job.indexOf("SELECT * FROM UNNEST"));
  const cols = insHead.slice(insHead.indexOf("(") + 1, insHead.lastIndexOf(")")).split(",").map((c) => c.trim());
  assert.ok(cols.includes("kommo_id"), "🔴 не вдалось розібрати список колонок вставки");
  for (const col of ["text", "result"])
    assert.ok(!cols.includes(col), `🔴 «${col}» потрапив у вставку (колонки: ${cols.join(", ")})`);
  // ⚠️ І в мапінгу клієнта теж: поле, знесене лише зі вставки, лишалось би в памʼяті
  //    процесу й у логах помилок.
  const client = src("kommo/client.ts");
  const map = client.slice(client.indexOf("export interface KommoTask"), client.indexOf("export async function forEachTaskPage"));
  assert.ok(!/^\s+text:/m.test(map) && !/^\s+result:/m.test(map.replace(/result\?: unknown;.*$/m, "")),
    "🔴 KommoTask несе text/result — вони доїдуть у памʼять і в логи");
});

test("#76d ЗБЕРЕЖЕНО ОБОХ АКТОРІВ — created_by І updated_by", () => {
  const schema = readFileSync(SCHEMA, "utf8");
  const tbl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS kommo_tasks"),
    schema.indexOf("idx_kommo_tasks_entity"));
  for (const col of ["created_by", "updated_by"])
    assert.ok(new RegExp(`^\\s+${col}\\s`, "m").test(tbl), `🔴 у схемі немає «${col}»`);

  const job = src("jobs/syncKommoTasks.ts");
  for (const col of ["created_by", "updated_by"])
    assert.ok(job.includes(col),
      `🔴 «${col}» не пишеться. Salesbot створює 47% задач, але 4 739 із них закрила `
      + "ЛЮДИНА, і у 204 угод у скоупі це ЄДИНА людська дія — фільтр за одним актором їх викине");
  assert.ok(job.includes("t.updatedBy") && job.includes("t.createdBy"),
    "🔴 актори не доїжджають із мапінгу клієнта у вставку");
});

test("#76e UPSERT ІДЕМПОТЕНТНИЙ і оновлює стан задачі", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    const ins = async (isDone: boolean, updBy: number, upd: string) => c.query(
      `INSERT INTO kommo_tasks (kommo_id, entity_id, entity_type, created_by, updated_by,
          is_completed, created_at, updated_at)
       VALUES (1, 100, 'leads', 0, $2, $1, '2026-01-01', $3)
       ON CONFLICT (kommo_id) DO UPDATE SET is_completed = EXCLUDED.is_completed,
          updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [isDone, updBy, upd]);
    await ins(false, 0, "2026-08-01");
    await ins(false, 0, "2026-08-01");
    assert.equal((await c.query(`SELECT count(*) n FROM kommo_tasks`)).rows[0].n, "1",
      "🔴 повторний прохід задвоїв задачу — вотермарк із перекриттям робить це щотіка");
    // Закриття СТАРОЇ задачі мусить доїхати: саме воно і є свіжою активністю.
    await ins(true, 12812476, "2026-08-11");
    const r = (await c.query(`SELECT is_completed, updated_by, updated_at FROM kommo_tasks WHERE kommo_id=1`)).rows[0];
    assert.equal(r.is_completed, true, "🔴 стан задачі не оновився — закриття лишиться невидимим");
    assert.equal(r.updated_by, 12812476, "🔴 «хто закрив» не оновився");
    assert.ok(new Date(r.updated_at) > new Date("2026-08-10"), "🔴 updated_at не зрушив");
    // 🔒 created_by НЕ оновлюється: автор задачі не змінюється, і перезапис затер би
    //    ознаку «створив бот» — саме те, чим ми відрізняємо ботові задачі.
    assert.equal((await c.query(`SELECT created_by FROM kommo_tasks WHERE kommo_id=1`)).rows[0].created_by, 0);
  } finally { await c.end(); }
});
