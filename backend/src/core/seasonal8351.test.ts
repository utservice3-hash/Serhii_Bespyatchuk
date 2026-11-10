import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { offSeason, cleanSeasonMonths } from "./reactivationRules.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #3453 🪞 — СЕЗОННИЙ НЕ В СЕЗОНІ (задача 8351, ТЗ Юлі 06.11; Роман 10.11 «роби»): по обидва боки межі місяця, сезон
 * через Новий рік, і позначка БЕЗ місяців НЕ діє (5 клієнтів, позначених до 8351, не зникають зі сплячих назавжди).
 * Ввід місяців чиститься: лише цілі 1–12, без повторів, по зростанню.
 * 🧨 Червоніє, якщо позначка без місяців почне діяти, межа сезону зсунеться або сезон через Новий рік зламається.
 */
test("#3453 🪞 СЕЗОН: не в сезоні — лише з місяцями, межа місяця по обидва боки, сезон через Новий рік", () => {
  const summer = [6, 7, 8, 9];
  assert.equal(offSeason(true, summer, 5), true, "🔴 травень (до сезону) — досі «сезон»");
  assert.equal(offSeason(true, summer, 6), false, "🔴 червень (перший місяць сезону) — «не сезон»");
  assert.equal(offSeason(true, summer, 9), false, "🔴 вересень (останній місяць сезону) — «не сезон»");
  assert.equal(offSeason(true, summer, 10), true, "🔴 жовтень (після сезону) — досі «сезон»");
  const winter = [11, 12, 1, 2];
  assert.deepEqual([12, 1, 2, 3, 10].map((m) => offSeason(true, winter, m)), [false, false, false, true, true], "🔴 сезон через Новий рік рахується неправильно");
  assert.equal(offSeason(true, [], 3), false, "🔴 позначка без місяців діє — клієнт зник би зі сплячих назавжди");
  assert.equal(offSeason(true, null, 3), false);
  assert.equal(offSeason(false, summer, 3), false, "🔴 не позначений клієнт — «не сезон»");
  assert.deepEqual(cleanSeasonMonths([9, "6", 6, 0, 13, 7.5, "x", 8]), [6, 8, 9], "🔴 місяці з вводу не почищені");
  assert.deepEqual(cleanSeasonMonths("6,7"), []);
});

/**
 * #3454 — ПРОВОДКА СЕЗОННОСТІ: ядро (`loadClientSegments`) читає місяці й робить «не в сезоні» НЕ сплячим; роут клієнтів
 * не кладе такого в реактивацію, а на «З ким говорити» — зелений і без «Немає роботи»; ставить лише КВП / ОД / адмін
 * (`isAdminScope`, тімлід — 403 у матриці), місяці обовʼязкові й чищені; картка віддає право й стан; кнопка — за правом.
 * 🧨 Червоніє, якщо будь-яке з місць повернеться до старого: тімлід знову ставить сезон, сезонний не в сезоні знову
 * сплячий або в реактивації, чи кнопка зʼявиться без права.
 */
test("#3454 ПРОВОДКА СЕЗОННОСТІ: ядро, реактивація, «З ким говорити», права КВП, картка, кнопка", () => {
  const seg = codeOnly(read("backend/src/core/clientSegments.ts"));
  assert.match(seg, /lo\.seasonal_months AS season_months/, "🔴 ядро не читає місяці сезону");
  assert.match(seg, /state: offSeason\(r\.seasonal, r\.season_months, monthNum\) \? "active" : stateOf\(daysSince, segment\)/, "🔴 сезонний не в сезоні досі сплячий / втрачений");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  assert.match(dash, /const off = factsFor\(seg, c\.client_key\)\.offSeason;\s*const color = off \? "green" as const : clientLeadRules\.colorOf/, "🔴 на «З ким говорити» сезонний не в сезоні — не зелений");
  assert.match(dash, /works: off \? \{ yes: true, by: "season" as const/, "🔴 на сезонному не в сезоні горить «Немає роботи»");
  const route = dash.slice(dash.indexOf('dashboardRouter.post("/client-seasonal"'), dash.indexOf("\ndashboardRouter.", dash.indexOf('dashboardRouter.post("/client-seasonal"') + 10));
  assert.match(route, /^[^\n]*\n\s*const auth = req\.auth!;\n\s*if \(!isAdminScope\(auth\)\) return res\.status\(403\)/, "🔴 сезон ставить не лише КВП / ОД / адмін, або межа не першою");
  assert.match(route, /reactivationRules\.cleanSeasonMonths\(req\.body\?\.months\)/, "🔴 місяці не чистяться");
  assert.match(route, /if \(seasonal && !months\.length\) return res\.status\(400\)/, "🔴 сезонний без місяців зберігається");
  assert.match(route, /seasonal_months = EXCLUDED\.seasonal_months/, "🔴 місяці не пишуться в базу");
  assert.match(dash, /canSeason: isAdminScope\(auth\),/, "🔴 картка віддає право сезону не тією межею, що роут");
  const matrix = read("backend/src/auth/accessMatrix.ts");
  assert.match(matrix, /path: "\/api\/dashboard\/client-seasonal", cls: "deny-only",\s*allow: \[\], deny: \["hr", "manager", "team_lead"\] \}/, "🔴 матриця не стверджує, що тімлід більше не ставить сезон");
  const card = codeOnly(read("frontend/src/pages/dashboard/sections/ClientCardPanel.tsx"));
  assert.match(card, /\{card\.canSeason && \(\s*<ClientSeasonBlock/, "🔴 кнопка сезону не за правом сервера");
});
