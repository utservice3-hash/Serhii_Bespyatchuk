import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fewTripsPerson, FEW_TRIPS_MIN } from "./reactivationRules.js";
import { clientKind } from "./orphanClients.js";

/**
 * 🚶 ЗАДАЧА 8339 (Дмитро Яцик 06.11 → Юля; Роман 11.11 «роби, 1 так, 2 закрий»): фізособа з менш ніж 3 успішними
 * поїздками, що заснула, — не в реактивації. 🗄 ЗАДАЧА 8323: тімлід сам архівує разового клієнта своєї команди.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #3825 🪞 — «ФІЗОСОБА З МЕНШ НІЖ 3 ПОЇЗДКАМИ» ПО ОБИДВА БОКИ: фіз із 2 — так, фіз із 3 — ні, юр/ФОП з 1 — ні; вид — те
 * саме правило, що в «Нічийних»: безнал / ЄДРПОУ-ІПН / форма в назві (ФОП, ТОВ) → юр, інакше фіз.
 * 🧨 Червоніє, якщо межу зсунути (3 поїздки знову «разові») або якщо ФОП/ТОВ почнуть читатись як фізособи — тоді з
 * реактивації зникнуть компанії, яких задача прямо велить лишити.
 */
test("#3825 🪞 ФІЗОСОБА <3 ПОЇЗДОК: межа 3 по обидва боки; юр/ФОП — ніколи; вид — правило «Нічийних»", () => {
  assert.equal(FEW_TRIPS_MIN, 3);
  assert.equal(fewTripsPerson({ kind: "person", orders: 2 }), true, "🔴 фізособа з 2 поїздками лишилась у реактивації");
  assert.equal(fewTripsPerson({ kind: "person", orders: 3 }), false, "🔴 фізособу з 3 поїздками прибрано — задача велить лишити");
  assert.equal(fewTripsPerson({ kind: "legal", orders: 1 }), false, "🔴 компанію прибрано за кількістю поїздок");
  const k = (name: string, anyCashless = false, hasCode = false) => clientKind({ name, anyCashless, hasCode }).kind;
  assert.equal(k("Тетяна"), "person");
  assert.equal(k("ФОП Коваленко Іван"), "legal", "🔴 ФОП прочитано як фізособу");
  assert.equal(k("ТОВ «Альфа»"), "legal");
  assert.equal(k("Сергій Завгородній", true), "legal", "🔴 безготівковий платник — фізособа");
  assert.equal(k("Петренко Петро", false, true), "legal", "🔴 клієнт із ЄДРПОУ/ІПН — фізособа");
});

/**
 * #3826 — ПРОВОДКА 8339 І 8323: місток «Клієнти та реактивація» прибирає фізосіб <3 поїздок ЛИШЕ серед сплячих і
 * втрачених (після дженериків, до лічильників сну) і називає їх `skippedFewTrips`; вид — одним пакетним запитом із назвою
 * з угод; `/reactivation-list` прибирає ту саму множину; фронт пояснює число. Картка дає «в архів» тімліду (`isAdminOrLead`),
 * а POST `/client-archive` і далі клампить тімліда по команді.
 * 🧨 Червоніє, якщо фільтр зачепить активних, зникне назване число, списки розійдуться або тімлід знову без кнопки.
 */
test("#3826 ПРОВОДКА: місток і список реактивації без фізосіб <3 поїздок (лише сплячі/втрачені); тімлід архівує сам", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'));
  const sleepBlock = plans.slice(plans.indexOf('if (f.state === "sleeping" || f.state === "lost") {'));
  const iGen = sleepBlock.indexOf("bridge.skippedGeneric++"), iFew = sleepBlock.indexOf("bridge.skippedFewTrips++"), iSleep = sleepBlock.indexOf("bridge.sleeping++");
  assert.ok(iGen > 0 && iFew > iGen && iSleep > iFew, "🔴 фізособи <3 поїздок прибираються не серед сплячих/втрачених або після лічильників сну");
  assert.match(plans, /clientKindFacts\.kindsFor\(pool, clientsRes\.rows\.map\(\(c\) => c\.client_key\)\)/, "🔴 вид клієнта не для всього списку");
  assert.match(plans, /skippedFewTrips: bridge\.skippedFewTrips,/, "🔴 прибраних не названо числом");
  const react = dash.slice(dash.indexOf('dashboardRouter.get("/reactivation-list"'));
  assert.match(react, /!\(c\.state !== "active" && reactivationRules\.fewTripsPerson\(\{ kind: kindR\.get\(c\.clientKey\) \?\? "legal", orders: c\.orders \}\)\)/,
    "🔴 список реактивації не прибирає ту саму множину — місток і список розійдуться");
  const kf = codeOnly(read("backend/src/core/clientKindFacts.ts"));
  assert.match(kf, /array_agg\(d\.client_name ORDER BY d\.closed_at_kommo DESC NULLS LAST\)/, "🔴 вид рахується не з назви з угод — роути дадуть різний вид");
  assert.match(kf, /clientKind\(\{ name:/, "🔴 вид — не правилом «Нічийних»");
  const card = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.match(card, /canArchive: isAdminOrLead\(auth\),/, "🔴 тімлід не бачить «в архів» (8323)");
  const arch = dash.slice(dash.indexOf('dashboardRouter.post("/client-archive"'));
  assert.match(arch.slice(0, 1500), /if \(!isAdminScope\(auth\)\) \{\s*const team = await clientOwnerTeam\(clientKey\);\s*if \(team == null \|\| team !== auth\.teamId\)/,
    "🔴 тімлід архівує клієнтів чужої команди");
  const fe = read("frontend/src/pages/dashboard/sections/ClientPlansSection.tsx");
  assert.match(fe, /t\.skippedFewTrips/, "🔴 екран не пояснює, куди зникли фізособи");
});
