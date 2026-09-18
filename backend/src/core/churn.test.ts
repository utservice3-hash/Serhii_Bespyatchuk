import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { monthRow, monthsBetween, type ChurnPerson } from "./churn.js";

/**
 * 📉 ПЛИННІСТЬ, EXIT, KOMMO (18.09.2026, етапи 4–5) — гейти `#583`–`#585`.
 * Номери з запасом над `#582` — борг 17: перед мержем перемірити перетин.
 */
const P = (hired: string | null, dismissed: string | null, reason: string | null = null): ChurnPerson =>
  ({ hired_at: hired, dismissed_at: dismissed, dismiss_reason: reason, position: "менеджер", team_label: "3" });

/**
 * #583 — ПЛИННІСТЬ ЯК У ТАБЛИЦІ: звільнено за місяць ÷ усіх, хто ПРАЦЮВАВ у місяці; прийнятий і звільнений
 * в одному місяці — і в «працював», і в «звільнено»; звільнений 1-го числа — ще працював у тому місяці;
 * без дати прийому — рахується й видно окремим числом; «ранні» — до 90 днів.
 * 🧨 Червоніє, якщо знаменник — лише ті, хто на кінець місяця, або межі місяця не включні.
 */
test("#583 ПЛИННІСТЬ: звільнені ÷ усі, хто працював у місяці; межі включно; без дати прийому — видно", () => {
  const ppl = [
    P("2025-01-10", null), P("2025-02-01", "2026-03-01", "ставка"), P("2026-03-05", "2026-03-20", "не підійшов"),
    P("2026-04-01", null), P(null, null), P("2024-06-01", "2026-02-28"),
  ];
  const m = monthRow(ppl, "2026-03");
  assert.deepEqual([m.headcount, m.hired, m.dismissed, m.early, m.noHireDate], [4, 1, 2, 1, 1], "🔴 не ті числа березня: " + JSON.stringify(m));
  assert.equal(m.turnover, 50, "🔴 плинність не 2 із 4");
  assert.equal(monthRow(ppl, "2026-02").headcount, 4, "🔴 звільнений 28.02 не працював у лютому");
  assert.equal(monthRow([], "2026-03").turnover, null, "🔴 порожній місяць дав число замість «немає»");
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  return { c, db: c as unknown as import("./secrets.js").Db, hr, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #584 — ПРИВʼЯЗКА ДО KOMMO: за «ID Kommo» з таблиці; інакше — за ЄДИНИМ збігом прізвища й імені;
 * однофамільців не вгадуємо; один менеджер — одна людина; повторний запуск нічого не міняє.
 * 🧨 Червоніє, якщо брати першого з однофамільців або привʼязати менеджера двічі.
 */
test("#584 ЖИВИЙ SQL: привʼязка до Kommo — за ID, за єдиним ПІБ, однофамільців не вгадує, повтор без змін", async (t) => {
  const s = await scratch(t); if (!s) return;
  const ch = await import("./churn.js");
  try {
    await s.c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (1,'Коваленко Олена',111),(2,'Бондар Андрій',222),(3,'Андрій Бондар',333),(4,'Сидоренко Марія',444)`);
    await s.c.query(`INSERT INTO employees (full_name, import_key, extra) VALUES
      ('Хтось Інший Зовсім','a','{"ID Kommo":"111"}'), ('Бондар Андрій Петрович','b','{}'), ('Сидоренко Марія Іванівна','c','{}'), ('Сидоренко Марія','d','{}')`);
    const r = await ch.linkKommo(s.db);
    const got = Object.fromEntries((await s.c.query(`SELECT import_key, manager_id FROM employees`)).rows.map((x) => [x.import_key, x.manager_id]));
    assert.equal(got.a, 1, "🔴 не привʼязано за ID Kommo");
    assert.equal(got.b, null, "🔴 однофамільців привʼязано навмання");
    assert.equal([got.c, got.d].filter((x) => x === 4).length, 1, "🔴 один менеджер на двох людях");
    assert.deepEqual([r.byId, r.ambiguous], [1, 1]);
    const again = await ch.linkKommo(s.db);
    assert.equal(again.linked, 0, "🔴 повторний запуск щось змінив");
  } finally { await s.done(); }
});

/**
 * #585 — EXIT-ІНТЕРВʼЮ: без ПІБ чи дати — 400; оцінка лише 1–10; зведення (середня оцінка, «порадив би»,
 * причини) рахується з записів; видалення скасовне; таблиця закрита для AI-помічника.
 * 🧨 Червоніє, якщо прийняти оцінку 0/11, рахувати видалені або прибрати REVOKE.
 */
test("#585 ЖИВИЙ SQL: Exit-інтервʼю — валідація, зведення, скасовне видалення, закрито для AI", async (t) => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "db", "schema.sql"), "utf8");
  assert.ok(sql.indexOf("REVOKE ALL ON exit_interviews FROM ai_readonly;") > sql.indexOf("CREATE TABLE IF NOT EXISTS exit_interviews ("), "🔴 REVOKE немає або вище за CREATE");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "ai", "metricTools.ts"), "utf8"), /"exit_interviews",/, "🔴 немає у FORBIDDEN_TABLES");
  const s = await scratch(t); if (!s) return;
  const ch = await import("./churn.js");
  try {
    const bad = (e: unknown) => (e as { status?: number }).status === 400;
    await assert.rejects(ch.createExit(s.db, s.hr, { interview_date: "2026-09-01" }), bad, "🔴 без ПІБ");
    await assert.rejects(ch.createExit(s.db, s.hr, { full_name: "А", interview_date: "2026-09-01", rating: 11 }), bad, "🔴 оцінку 11 прийнято");
    const a = await ch.createExit(s.db, s.hr, { full_name: "Коваленко Олена", interview_date: "2026-09-01", reason: "ставка", rating: 8, recommend: "Так" });
    await ch.createExit(s.db, s.hr, { full_name: "Бондар Андрій", interview_date: "2026-09-02", reason: "ставка", rating: 4, recommend: "Ні" });
    const c = await ch.createExit(s.db, s.hr, { full_name: "Сидоренко Марія", interview_date: "2026-09-03", reason: "переїзд", rating: 10, recommend: "так" });
    let l = await ch.listExits(s.db);
    assert.deepEqual([l.stats.total, l.stats.avgRating, l.stats.recommendPct, l.stats.reasons[0]], [3, 7.3, 67, { label: "ставка", n: 2 }]);
    await ch.updateExit(s.db, a, { rating: 2 });
    await ch.setExitDeleted(s.db, c, true);
    l = await ch.listExits(s.db);
    assert.deepEqual([l.stats.total, l.stats.avgRating], [2, 3], "🔴 видалене пораховано або зміна не лягла");
    await ch.setExitDeleted(s.db, c, false);
    assert.equal((await ch.listExits(s.db)).stats.total, 3, "🔴 відновлення не повернуло запис");
  } finally { await s.done(); }
});
