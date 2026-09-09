import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dateParam } from "../core/queryParams.js";
import { mergeAdDays } from "./report.js";

/**
 * 📣 #371–#372b — ДВА ДЕФЕКТИ ЕКРАНА «РЕКЛАМА», ЗНАЙДЕНІ ПІСЛЯ ВИКАТУ 08.09.2026.
 *
 * Обидва пройшли `tsc`, обидва пройшли 944 гейти, і жоден не був би помітний із
 * коду — перший валить роут, другий друкує правдоподібне неправильне число.
 *
 * 🔴 №1 (`#371`): порожня дата. Швидкий період «Весь час» віддає `{from:"",to:""}`;
 * axios порожні рядки НЕ відкидає, `?? null` їх не ловить, і в SQL летить
 * `('')::date` → `22007`. Express 4 async-reject не ловить, тож відповіді немає
 * 20 секунд, і весь цей час воркер зайнятий — той самий клас, що поклав сайт 27.07.
 *
 * 🔴 №2 (`#372`): день існував лише тоді, коли про нього знав GA4. Ліди рахує
 * ядро, але вони лише прищеплювались до вже наявного дня — тож поки GA4 не
 * підключено, екран друкував «Платних лідів: 0» при сотнях лідів у CRM.
 *
 * ⚠️ ЧОМУ ГЕЙТИ ТУТ, А НЕ НА РОУТІ. Роут потребує БД і живих налаштувань, тобто
 * скіпався б у деві — а це рівно та «страховка, що ніколи не виконувалась», яку
 * ми лікували 07.09. Обидві властивості винесені в чисті функції саме щоб бігти
 * у БУДЬ-ЯКОМУ оточенні; що роут кличе саме їх, стереже дзеркало `#372b`.
 */

// ⚠️ Шлях від DIST, а не від src: тест біжить як `dist/ga4/…`, тож джерело
// лежить на два рівні вище й у `src`. Перша редакція вказувала на
// `dist/routes/dashboard.ts` — файла, якого не існує, і гейт падав із ENOENT.
const ROUTE_SRC = fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url));

test("#371 ПОРОЖНЯ ДАТА — це «не задано», а не значення (інакше роут висить 20 с і віддає 503)", () => {
  // ① Власне випадок «Весь час».
  assert.equal(dateParam(""), null);
  assert.equal(dateParam("   "), null);
  // ② Відсутність параметра.
  assert.equal(dateParam(undefined), null);
  assert.equal(dateParam(null), null);
  // ③ Повторений параметр `?from=a&from=b` приходить масивом — теж не дата.
  assert.equal(dateParam(["2026-09-01", "2026-09-02"]), null);

  // 🪞 ДЗЕРКАЛО: справжня дата мусить ПРОЙТИ. Без цього гейт був би зеленим і на
  // функції, що повертає null завжди, — тобто на екрані, який не показує нічого.
  assert.equal(dateParam("2026-09-01"), "2026-09-01");
  assert.equal(dateParam(" 2026-09-01 "), "2026-09-01");
});

test("#372 GA4 ПОРОЖНІЙ, А ЛІДИ Є — день усе одно в таблиці, і «0 лідів» не друкується", () => {
  const leads = new Map([["2026-09-01", { entered: 17, won: 3 }]]);
  const sheet = new Map([["2026-09-02", 4200]]);

  // GA4 не підключено: кампаній нема ЗОВСІМ — саме той стан, що був на проді.
  const days = mergeAdDays([], leads, sheet);

  assert.deepEqual(days.map((d) => d.day), ["2026-09-01", "2026-09-02"],
    "🔴 день, про який знають ліди або аркуш, зник із таблиці — знаменник CPL занижений, отже CPL завищений");
  assert.equal(days[0].leads, 17, "🔴 ліди з ядра не дійшли до дня без GA4 — екран покаже «0 платних лідів» при сотнях у CRM");
  assert.equal(days[0].cost, 0, "витрат GA4 справді немає — це нуль-як-вимір, а не нуль-як-порожнеча");
  assert.equal(days[1].sheetCost, 4200, "день з аркуша мусить лишитись видимим");
  assert.equal(days[0].sheetCost, null, "🔴 день без аркуша мусить давати null («—»), а не 0: нуль означав би «витрат не було»");
});

test("#372b 🪞 ІНВАРІАНТ ГРУПУВАННЯ ЖИВИЙ, і роут кличе саме ці функції", () => {
  // ① Обʼєднання додає РЯДКИ, а не гроші: Σ по днях == Σ по кампаніях.
  const campaigns = [
    { day: "2026-09-01", cost: 100.5, clicks: 10, sessions: 40 },
    { day: "2026-09-01", cost: 200.25, clicks: 20, sessions: 60 },
    { day: "2026-09-03", cost: 50, clicks: 5, sessions: 15 },
  ];
  const days = mergeAdDays(campaigns, new Map([["2026-09-02", { entered: 4, won: 1 }]]), new Map());
  const sumDays = days.reduce((s, d) => s + d.cost, 0);
  const sumCampaigns = campaigns.reduce((s, c) => s + c.cost, 0);
  assert.equal(Math.round(sumDays * 100), Math.round(sumCampaigns * 100),
    "🔴 обʼєднання зрушило СУМУ — воно має додавати дні з нульовою вартістю, а не гроші");
  assert.equal(days.find((d) => d.day === "2026-09-02")!.cost, 0, "день лише з лідами має витрати 0");

  // ② Функції не лежать мертвими модулями: роут кличе саме їх, а не свою копію.
  const src = readFileSync(ROUTE_SRC, "utf8");
  assert.match(src, /const from = dateParam\(req\.query\.from\)/,
    "🔴 роут /ads більше не нормалізує дату через dateParam — порожній рядок знову дійде до ('')::date");
  assert.match(src, /const days = mergeAdDays\(campaigns, leadsByDay, sheetByDay\)/,
    "🔴 роут /ads більше не кличе mergeAdDays — дні знову будуються з самого GA4, і ліди зникають разом із днем");
});
