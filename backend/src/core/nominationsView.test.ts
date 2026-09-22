/**
 * 🏆 НОМІНАЦІЇ — ЛОГІКА ЕКРАНА (`frontend/src/pages/dashboard/nominationsView.ts`), ВИКОНАНА, А НЕ ПРОЧИТАНА.
 * Той самий прийом, що `#370`: файл транспілюється й імпортується, тож гейт бачить рівно те, що біжить у браузері.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/nominationsView.ts", import.meta.url).href.replace("/backend/dist/", "/backend/src/"));
async function loadView() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const cell = (nomination: string, crm: unknown, status: string, winners: number[], value: number | null, review: unknown = null) =>
  ({ nomination, crm, final: { status, winners, value, reason: status === "overridden" ? "звідки" : null, stale: false }, deal: null, ranking: null, review, canReview: true, whyNot: null });

/**
 * #650 — ГРУПИ КАРТОК, ГОТОВНІСТЬ КОМАНДИ Й ПОВІДОМЛЕННЯ ДАШІ. Рядок, де переможець — тімлід, іде в «про вас»
 * (а не в «чекають вас»); порожній — окремо й не в знаменнику; «свої дані» — вирішено. Повідомлення веде на
 * тиждень (`?week=`) і перелічує ЛИШЕ команди, де ще щось чекає тімліда. 🧨 Прибрати перевірку «про себе»,
 * рахувати порожнє в знаменнику чи не відфільтровувати готові команди — червоне.
 */
test("#650 екран: «про вас» окремо, порожнє не в знаменнику, повідомлення — лише про тих, хто не перевірив", async () => {
  const { groupCells, teamProgress, frozenSummary, leadsMessage } = await loadView();
  const ok = (w: number[], v: number) => ({ state: "ok", value: v, winners: w });
  const cells = [
    cell("maxDeal", ok([103], 50000), "unconfirmed", [103], 50000),          // про тімліда
    cell("cars", ok([101, 102], 2), "unconfirmed", [101, 102], 2),           // чекає
    cell("revenue", ok([101], 36580), "confirmed", [101], 36580, { action: "confirm", by: "Тімлід", at: "2026-09-21T15:40:00.000Z" }),
    cell("marginPct", ok([101], 1200), "overridden", [102], 900, { action: "override", by: "Тімлід", at: "2026-09-21T16:00:00.000Z" }),
    cell("intl", { state: "empty" }, "empty", [], null),
  ];
  const g = groupCells(cells, [103]);
  assert.deepEqual([g.pending, g.done, g.about, g.empty].map((l: { nomination: string }[]) => l.map((c) => c.nomination)),
    [["cars"], ["revenue", "marginPct"], ["maxDeal"], ["intl"]], "🔴 групи карток не ті");
  const team = { teamId: 13, teamName: "РНК - Тест", dept: "rnk", members: [], noCostDeals: 0, cells, leads: [{ managerId: 103, name: "Тімлід" }] };
  const p = teamProgress(team);
  assert.deepEqual([p.done, p.total, p.waitLead, p.waitBoss, p.lastAt], [2, 4, ["cars"], ["maxDeal"], "2026-09-21T16:00:00.000Z"], "🔴 готовність команди порахована не так");
  const doneTeam = { ...team, teamId: 5, teamName: "РПК - Готова", cells: [cells[2], cells[4]] };
  const week = { weekFrom: "2026-09-14", weekTo: "2026-09-20", freezeDueAt: "2026-09-22 08:00", teams: [team, doneTeam] };
  const msg = leadsMessage(week, "https://dashboard.uts.ua");
  assert.match(msg, /https:\/\/dashboard\.uts\.ua\/nominations\?week=2026-09-14/, "🔴 повідомлення не веде на тиждень");
  assert.match(msg, /РНК - Тест \(2 з 4\)/, "🔴 команда, що не перевірила, не згадана");
  assert.doesNotMatch(msg, /РПК - Готова/, "🔴 готова команда потрапила в «ще чекаємо»");
  assert.deepEqual(frozenSummary([team]), { confirmed: 1, own: 1, noDecision: 2 });
  // Вид розкриття на екрані — той самий, що звіряє живий #658 (результат і зазор — «Факт», авто — завантажені).
  const { DRILL_KIND } = await loadView();
  assert.deepEqual(DRILL_KIND, { maxDeal: "received", revenue: "received", cars: "dispatched", marginPct: null, intl: null }, "🔴 екран розкриває число не тим видом, що звіряє #658");
});

/**
 * #651 — ВВЕДЕННЯ Й ПІДКАЗКИ. «11 200», «11 200 ₴», «312%», «12,5» — числа; порожнє, «abc», «0», «-5» — ні
 * (досі «11 200» давало 400). Підказка «свої дані» каже, в кого за CRM більше, і не кричить, коли число збігається.
 * `?week=` — лише справжня дата. Відлік: жовтий менше доби, червоний менше 3 год, «час вийшов» — після.
 */
test("#651 введення: числа з пробілами й ₴ приймаються, сміття — ні; підказка «свої дані» по обидва боки", async () => {
  const { parseAmount, ownDataHint, parseWeekParam, countdown } = await loadView();
  for (const [s, v] of [["11 200", 11200], ["11 200 ₴", 11200], ["11 200", 11200], ["312%", 312], ["12,5", 12.5], ["7", 7]] as const) {
    assert.equal(parseAmount(s), v, `🔴 «${s}» не прочиталось як ${v}`);
  }
  for (const s of ["", "abc", "0", "-5", "1 2 x"]) assert.equal(parseAmount(s), null, `🔴 «${s}» прийнято як число`);
  const ranking = [{ managerId: 1, value: 16920 }, { managerId: 2, value: 15000 }, { managerId: 3, value: 14000 }];
  const h = ownDataHint(ranking, [3], 14000);
  assert.deepEqual([h.differs, h.higher.map((x: { managerId: number }) => x.managerId)], [false, [1, 2]], "🔴 підказка не назвала тих, у кого за CRM більше");
  const h2 = ownDataHint(ranking, [1], 16920);
  assert.deepEqual([h2.differs, h2.higher.length], [false, 0], "🔴 підказка кричить, коли число збігається з CRM");
  assert.equal(ownDataHint([{ managerId: 5, value: 5 }], [5], 21).differs, true, "🔴 «21 проти 5 у CRM» не підсвічено");
  assert.equal(parseWeekParam("?week=2026-09-14"), "2026-09-14");
  for (const q of ["?week=2026-13-01", "?week=abc", "", "?week=2026-02-30"]) assert.equal(parseWeekParam(q), null, `🔴 «${q}» прийнято як тиждень`);
  const due = "2026-09-22T05:00:00.000Z", at = Date.parse(due);
  assert.deepEqual(countdown(due, at - 26 * 3_600_000), { text: "1 д 2 год", level: "calm" });
  assert.equal(countdown(due, at - 14 * 3_600_000).level, "warn");
  assert.equal(countdown(due, at - 2 * 3_600_000).level, "danger");
  assert.equal(countdown(due, at + 1).level, "past");
});
