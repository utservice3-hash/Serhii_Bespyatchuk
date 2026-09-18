import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFunnel, buildRefusals, buildCut, reachedRank, type FunnelCandidate } from "./hiringFunnel.js";

/**
 * 📊 ЗВЕДЕННЯ НАЙМУ — воронка (18.09.2026, етап 2) — гейти `#573`–`#575`.
 * Номери з запасом над `#572` — борг 17: перед мержем перемірити перетин.
 */

const C = (id: number, status: string, visited: string[], extra: Partial<FunnelCandidate> = {}): FunnelCandidate =>
  ({ id, source: "work.ua", status, visited, refusal_side: null, refusal_reason: null, reserved: false, vacancies: [], ...extra });

/** 10 нових: 8 написали, 4 співбесіди (1 — одразу «призначено», без «першого повідомлення»), 2 до тімліда, 1 менеджер. */
const COHORT: FunnelCandidate[] = [
  C(1, "manager", ["new", "contacted", "planned", "done", "lead", "candidate", "training", "manager"]),
  C(2, "refused", ["new", "contacted", "planned", "done", "lead"], { refusal_side: "company", refusal_reason: "Не пройшов по софтам" }),
  C(3, "done", ["new", "planned", "done"], { source: "LinkedIn" }),
  C(4, "refused", ["new", "contacted", "planned", "done"], { refusal_side: "candidate", refusal_reason: "Інша ставка" }),
  C(5, "noshow", ["new", "contacted", "planned", "noshow"]),
  C(6, "contacted", ["new", "contacted"]),
  C(7, "refused", ["new", "contacted"], { refusal_side: "candidate", refusal_reason: "Інша ставка" }),
  C(8, "black", ["new", "contacted"]),
  C(9, "noanswer", ["new", "noanswer"], { source: null }),
  C(10, "new", ["new"], { source: null }),
];

/**
 * #573 — ВОРОНКА НЕ ЗРОСТАЄ ВНИЗ і рахує «дійшов» за найдальшим етапом: хто перескочив етап — його
 * пройшов; «не прийшов» — дійшов до «призначено»; розріз за джерелом у сумі == усій когорті.
 * 🧨 Червоніє, якщо рахувати лише поточний статус або лише події цього етапу.
 */
test("#573 ВОРОНКА: дійшов за найдальшим етапом, не зростає вниз, Σ за джерелами == когорта", () => {
  const f = buildFunnel(COHORT);
  assert.deepEqual(f.map((s) => s.count), [10, 8, 5, 4, 2, 1, 1, 1], "🔴 не ті кількості на етапах: " + f.map((s) => `${s.key}=${s.count}`).join(" "));
  for (let i = 1; i < f.length; i++) assert.ok(f[i].count <= f[i - 1].count, `🔴 етап «${f[i].label}» більший за попередній`);
  assert.equal(reachedRank(COHORT[2]), 3, "🔴 перескочив «перше повідомлення» — а воронка його не зарахувала");
  const bySrc = buildCut(COHORT, (c) => [{ key: c.source ?? "—", label: c.source ?? "не вказано" }]);
  assert.equal(bySrc.reduce((a, r) => a + r.added, 0), COHORT.length, "🔴 Σ за джерелами ≠ когорті");
  const two = [C(1, "done", ["new", "done"], { vacancies: [{ id: 1, title: "A" }, { id: 2, title: "B" }] })];
  assert.deepEqual(buildCut(two, (c) => c.vacancies.map((v) => ({ key: String(v.id), label: v.title }))).map((r) => r.added), [1, 1],
    "дзеркало: кандидат на двох вакансіях — у рядку кожної");
  assert.equal(buildFunnel(two)[0].count, 1, "🔴 кандидата на двох вакансіях пораховано двічі в загальній воронці");
});

/**
 * #574 — КОНВЕРСІЯ ВІД ПОПЕРЕДНЬОГО етапу (і окремо від першого); відмови кандидата + компанії
 * (+ без сторони) == усім відмовам; чорний список — відмова компанії.
 * 🧨 Червоніє, якщо відносну конверсію рахувати від першого етапу або загубити чорний список.
 */
test("#574 ВІДМОВИ Й КОНВЕРСІЯ: від попереднього етапу; кандидат + компанія == усім відмовам", () => {
  const f = buildFunnel(COHORT);
  assert.equal(f[2].fromPrev, 62.5, "🔴 «призначено» рахується не від попереднього етапу (5 із 8)");
  assert.equal(f[2].fromFirst, 50, "🔴 загальна конверсія «призначено» не 5 із 10");
  assert.equal(f[1].lost, 3, "🔴 втрати між «перше повідомлення» і «призначено» — 8 − 5");
  const r = buildRefusals(COHORT);
  assert.deepEqual([r.total, r.candidate, r.company, r.unknown], [4, 2, 2, 0], "🔴 відмови розкладено не так");
  assert.equal(r.candidate + r.company + r.unknown, r.total, "🔴 сторони відмов не дають суму");
  assert.equal(r.share, 40, "🔴 частка відмов від когорти");
  assert.deepEqual(r.reasons[0], { side: "candidate", label: "Інша ставка", n: 2 }, "🔴 топ причина не та");
  assert.ok(r.reasons.some((x) => x.label === "чорний список" && x.side === "company"), "🔴 чорний список не пораховано відмовою компанії");
});

/**
 * #575 — ЖИВИЙ SQL: межі періоду — київські дати, ОБИДВА кінці включно. 31.08 23:30 за Києвом — серпень,
 * 01.09 00:10 за Києвом — вересень (хоча в UTC обидва ще 31.08). Фільтр вакансії й джерела звужують когорту.
 * 🧨 Червоніє, якщо порівнювати UTC-дату або повернути `created_at <= $to`.
 */
test("#575 ЖИВИЙ SQL: зведення — київські межі періоду включно, фільтри вакансії й джерела", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    const ins = async (name: string, at: string, source: string, status: string) => (await c.query(
      `INSERT INTO hiring_candidates (full_name, source, status, created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [name, source, status, at])).rows[0].id as number;
    const late = await ins("Серпнева Остання", "2026-08-31T20:30:00Z", "work.ua", "new");     // 31.08 23:30 Київ
    const early = await ins("Вереснева Перша", "2026-08-31T21:10:00Z", "LinkedIn", "contacted"); // 01.09 00:10 Київ
    const v = (await c.query(`INSERT INTO hiring_vacancies (title) VALUES ('Менеджер з продажу') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO hiring_candidate_vacancies (candidate_id, vacancy_id) VALUES ($1,$2)`, [early, v]);
    const { hiringSummary } = await import("./hiringFunnel.js");
    const db = c as unknown as import("./secrets.js").Db;
    const aug = await hiringSummary(db, { from: "2026-08-01", to: "2026-08-31" });
    const sep = await hiringSummary(db, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(aug.total, 1, "🔴 31.08 23:30 за Києвом випало із серпня (межа не включна або UTC)");
    assert.equal(sep.total, 1, "🔴 01.09 00:10 за Києвом не потрапило у вересень");
    assert.equal(sep.funnel[1].count, 1, "🔴 «перше повідомлення» зі статусу не зараховане");
    assert.equal((await hiringSummary(db, { from: "2026-08-01", to: "2026-09-30", vacancyId: v })).total, 1, "🔴 фільтр вакансії");
    assert.equal((await hiringSummary(db, { from: "2026-08-01", to: "2026-09-30", source: "work.ua" })).total, 1, "🔴 фільтр джерела");
    await assert.rejects(hiringSummary(db, { from: "2026-09-30", to: "2026-09-01" }), (e: unknown) => (e as { status?: number }).status === 400);
    void late;
  } finally { await c.end(); s.dispose(); }
});
