import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsBackendEnv } from "../testMode.js";
import {
  ftNameKey, ftNameKeySql, firstTouchCell, firstTouchPct, sumFirstTouch, firstTouchByCallerSql, firstTouchMetaSql, FT_NO_RECORD,
} from "./firstTouchRules.js";

/**
 * 🎯 #467–#470 — ТЗ-3 «ЦІНУ НАЗВАНО В ПЕРШИЙ ДОТИК» у живому Звіті (17.09.2026).
 * Рішення власника: дотик — тому, хто ДЗВОНИВ; чесні стани («не вимірюється», «без запису» поза
 * відсотком); доступ як у решти Звіту.
 */

test("#467 ПЕРШИЙ ДОТИК · ПРАВИЛА: ключ імені, три стани, відсоток лише з оцінених", () => {
  assert.equal(ftNameKey("Безпам'ятний Андрій Олегович"), "безпамятний андрій");
  assert.equal(ftNameKey("  Безпамʼятний\tАндрій "), "безпамятний андрій", "🔴 апостроф ʼ або табуляція розводять одну людину на дві");
  assert.equal(ftNameKey("Безпамятний Андрій"), "безпамятний андрій");
  assert.equal(ftNameKey(""), "");
  assert.notEqual(ftNameKey("Пехньо Ксенія"), ftNameKey("Пехньо Олександра"), "🔴 різні люди з одним прізвищем злились");

  const covered = new Set([7]);
  assert.equal(firstTouchCell(undefined, 3, covered).state, "not_covered", "🔴 команду, яку бот не слухає, показано як «0 з 0»");
  assert.equal(firstTouchCell(undefined, null, covered).state, "not_covered");
  assert.deepEqual(firstTouchCell(undefined, 7, covered), { state: "measured", analyzed: 0, voiced: 0, noRecord: 0 },
    "🔴 покрита команда без оцінок за період — це «оцінок немає», а не «не вимірюється»");
  assert.equal(firstTouchCell({ analyzed: 2, voiced: 1, noRecord: 0 }, 3, covered).state, "measured",
    "🔴 наявні оцінки сховано лише тому, що людина змінила команду");

  assert.equal(firstTouchPct(0, 0), null, "🔴 нуль оцінених — це «нема з чого рахувати», а не 0%");
  assert.equal(firstTouchPct(1, 3), 33.3);
  assert.deepEqual(sumFirstTouch([{ analyzed: 1, voiced: 1, noRecord: 2 }, { analyzed: 40, voiced: 10, noRecord: 0 }]),
    { analyzed: 41, voiced: 11, noRecord: 2 });
  assert.equal(FT_NO_RECORD, "немає запису", "🔴 позначка «розмови не чули» розійшлась із тим, що пише бот (sheets.py)");
});

/**
 * #468 — ЖИВИЙ SQL: звʼязка з тим, хто ДЗВОНИВ, а не з угодою; «немає запису» поза знаменником;
 * межі періоду з обох боків; покриття команд; ключ імені в SQL == ключ у JS.
 */
test("#468 ПЕРШИЙ ДОТИК · ЖИВИЙ SQL: тому, хто дзвонив; без запису окремо; межі; покриття", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РНК - Безпамʼятного Андрія'),(2,'РПК') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (10,'Безпамятний Андрій',1,true),(11,'Дьяков Денис Євгенович',1,true),(12,'Чукін Євген',2,true),
      (13,'Дьяков Денис',NULL,false) ON CONFLICT DO NOTHING`);
    // Угоду ліда 1 потім передали Чукіну — дотик однаково Дьякова.
    await c.query(`INSERT INTO deals (kommo_id, manager_id) VALUES (1, 12), (2, 10)`);
    const row = (lead: number, day: string, voiced: boolean, transport: string, mgr: string) =>
      c.query(`INSERT INTO first_touch_analysis (lead_id, analyzed_at, price_voiced, objections_handled, about_transport, manager_name, team_name)
               VALUES ($1,$2,$3,false,$4,$5,'Безпам''ятний')`, [lead, day, voiced, transport, mgr]);
    await row(1, "2026-09-01", true, "так", "Дьяков Денис Євгенович");
    await row(2, "2026-09-02", false, "так", "Безпам'ятний Андрій");
    await row(3, "2026-09-03", false, FT_NO_RECORD, "Безпамʼятний  Андрій");       // без запису
    await row(4, "2026-09-30", true, "так", "Безпамятний Андрій");                // останній день періоду
    await row(5, "2026-08-31", true, "так", "Безпамятний Андрій");                // день ДО періоду
    await row(6, "2026-09-05", true, "так", "Невідомий Хтось");                   // не звʼязався
    await row(7, "2026-10-01", true, "так", "Безпамятний Андрій");                // день ПІСЛЯ

    const q = firstTouchByCallerSql("2026-09-01", "2026-09-30");
    const by = new Map((await c.query<{ manager_id: number | null; analyzed: number; voiced: number; no_record: number }>(q.sql, q.params)).rows
      .map((r) => [r.manager_id, [Number(r.analyzed), Number(r.voiced), Number(r.no_record)]]));
    assert.deepEqual(by.get(11), [1, 1, 0], "🔴 дотик пішов не тому, хто дзвонив (угоду передали Чукіну), або однойменного неактивного обрано першим");
    assert.equal(by.get(12), undefined, "🔴 дотик приписано поточному відповідальному угоди, а не тому, хто говорив");
    assert.deepEqual(by.get(10), [2, 1, 1], "🔴 межі періоду або апострофи: у Безпамʼятного мало бути 2 оцінені (1 названо) і 1 без запису");
    assert.deepEqual(by.get(null), [1, 1, 0], "🔴 незвʼязана оцінка зникла замість стати другим числом");
    const total = [...by.values()].reduce((n, v) => n + v[0] + v[2], 0);
    assert.equal(total, 5, "🔴 Σ по менеджерах + незвʼязані ≠ рядків у періоді");

    const meta = (await c.query<{ covered_team_ids: number[]; last_analyzed_at: string }>(firstTouchMetaSql())).rows[0];
    assert.deepEqual([...meta.covered_team_ids].map(Number).sort(), [1], "🔴 покриття: бот оцінює лише команду 1");
    assert.equal(meta.last_analyzed_at, "2026-10-01");

    // Ключ SQL == ключ JS — інакше звʼязка в базі й правило в коді означають різне.
    for (const name of ["Безпам'ятний Андрій Олегович", "  Безпамʼятний\tАндрій ", "Чукін  Євген", "", "Одне"]) {
      const sqlKey = (await c.query<{ k: string }>(`SELECT ${ftNameKeySql("$1::text")} AS k`, [name])).rows[0].k;
      assert.equal(sqlKey, ftNameKey(name), `🔴 ключ імені в SQL («${sqlKey}») ≠ JS («${ftNameKey(name)}») для «${name}»`);
    }
  } finally { await c.end(); scratch.dispose(); }
});

/**
 * #470 — ЖИВА БД: Σ по менеджерах + незвʼязані == усі рядки періоду (останні 90 днів), і маршрут
 * справді кладе клітинку й суму команди у відповідь Звіту.
 */
test("#470 ПЕРШИЙ ДОТИК · ЖИВА БД: Σ менеджерів + незвʼязані == рядки періоду", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { kyivToday } = await import("./dates.js");
  const to = kyivToday();
  const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 90);
  const from = d.toISOString().slice(0, 10);
  const all = Number((await pool.query<{ n: string }>(`SELECT count(*) n FROM first_touch_analysis WHERE analyzed_at BETWEEN $1::date AND $2::date`, [from, to])).rows[0].n);
  const skip = emptyPeriodSkip("оцінок першого дотику", all, `${from}…${to}`);
  if (skip) return t.skip(skip);
  const q = firstTouchByCallerSql(from, to);
  const rows = (await pool.query<{ analyzed: number; no_record: number }>(q.sql, q.params)).rows;
  const sum = rows.reduce((n, r) => n + Number(r.analyzed) + Number(r.no_record), 0);
  assert.equal(sum, all, `🔴 Σ по менеджерах + незвʼязані (${String(sum)}) ≠ рядків у періоді (${String(all)}) — оцінка загубилась або подвоїлась у звʼязці`);
});

test("#470b ПРОВОДКА: Звіт кладе клітинку менеджера, суму команди й метадані джерела", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");
  assert.match(src, /firstTouch: firstTouchCell\(ft\.byManager\.get\(m\.id\), m\.team_id, ft\.coveredTeamIds\)/, "🔴 рядок менеджера без «першого дотику»");
  assert.match(src, /firstTouch: sumFirstTouch\(managers\.map\(\(m\) => m\.firstTouch\)\)/, "🔴 рядок команди не з тих самих клітинок");
  assert.match(src, /firstTouchMeta: \{ unmapped: ft\.unmapped, lastAnalyzedAt: ft\.lastAnalyzedAt, coveredTeams: ft\.coveredTeamIds\.size \}/,
    "🔴 екран не знає, коли бот мовчить і скільки оцінок не звʼязалось");
});
