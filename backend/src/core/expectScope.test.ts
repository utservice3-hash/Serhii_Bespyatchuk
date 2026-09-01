import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsBackendEnv, emptyPeriodSkip } from "../testMode.js";
import {
  reaches, divergenceKlass, scopeDivergence, tallyFor, KLASS_LABEL,
  type ZoneDeal, type DivergenceKlass,
} from "./expectScope.js";

/**
 * 🔭 #270–#270c — ТРИ ЧИТАЧІ ЗОНИ ОЧІКУВАНЬ МУСЯТЬ БАЧИТИ ОДНЕ Й ТЕ САМЕ.
 *
 * 🔴 ЧОМУ ФІКСТУРА, А НЕ ЖИВІ ДАНІ. На проді 01.09.2026 у КОЖНОМУ з чотирьох класів
 * розбіжності рівно 0 угод (заміряно: зона 336 угод / 837 043 ₴, усі три читачі дали
 * те саме число). Гейт, побудований на цьому нулі, доводив би лише те, що сьогодні
 * порожньо, — і лишався б зеленим після будь-якої правки предикатів. Тому властивість
 * перевіряється на ШТУЧНІЙ НЕПОРОЖНІЙ множині розбіжності, де кожен клас представлений
 * поіменно, а живий стан прода стереже окремий будильник `#270c`.
 */

/** Угода, що доходить до всіх трьох читачів, — контроль «гейт не всіх записав у винні». */
const OK: ZoneDeal = { kommoId: 1, price: 10_000, managerId: 7, managerActive: true, teamId: 3 };
/** По одній угоді на КОЖЕН клас відмови — множина розбіжності свідомо НЕПОРОЖНЯ. */
const NO_MGR: ZoneDeal = { kommoId: 2, price: 20_000, managerId: null, managerActive: null, teamId: null };
const UNKNOWN: ZoneDeal = { kommoId: 3, price: 30_000, managerId: 99, managerActive: null, teamId: null };
const INACTIVE: ZoneDeal = { kommoId: 4, price: 40_000, managerId: 8, managerActive: false, teamId: 3 };
const NO_TEAM: ZoneDeal = { kommoId: 5, price: 50_000, managerId: 9, managerActive: true, teamId: null };
const MIXED = [OK, NO_MGR, UNKNOWN, INACTIVE, NO_TEAM];

test("#270 РОЗБІЖНІСТЬ ІМЕНУЄТЬСЯ ПОКЛАСОВО, і кожен клас має СВОЮ причину", () => {
  /**
   * 🔴 Клас на кожну відмову, а не спільний смітник. Під одним підписом «менеджер не
   * підходить» жили б чотири різні причини, і для трьох із чотирьох підпис брехав би —
   * рівно та помилка, що коштувала нам проходу на зіставленні платежів.
   */
  assert.equal(divergenceKlass(OK), null, "🔴 угода, що доходить усюди, названа розбіжністю");
  assert.equal(divergenceKlass(NO_MGR), "no-manager");
  assert.equal(divergenceKlass(UNKNOWN), "unknown-manager",
    "🔴 осиротіле посилання злилось із «неактивний» — це різні відмови з різними діями");
  assert.equal(divergenceKlass(INACTIVE), "inactive-manager");
  assert.equal(divergenceKlass(NO_TEAM), "no-team");

  const groups = scopeDivergence(MIXED);
  assert.equal(groups.length, 4, "🔴 не всі чотири класи впізнані на множині, де є всі чотири");
  assert.deepEqual(groups.map((g) => g.klass).sort(),
    ["inactive-manager", "no-manager", "no-team", "unknown-manager"]);
  assert.equal(groups.reduce((s, g) => s + g.deals, 0), 4);
  assert.equal(groups.reduce((s, g) => s + g.sum, 0), 140_000,
    "🔴 сума розбіжності не сходиться — на екрані це буде рівно ця дірка в ₴");
  assert.ok(!groups.some((g) => g.ids.includes(OK.kommoId)),
    "🔴 здорова угода потрапила в розбіжність — гейт червонітиме на робочих даних");
  // Кожен клас мусить мати ЛЮДСЬКИЙ підпис: без нього будильник назве причину кодом.
  for (const k of Object.keys(KLASS_LABEL) as DivergenceKlass[]) assert.ok(KLASS_LABEL[k].length > 10);
});

test("#270b 🪞 ДЗЕРКАЛО: три читачі розходяться САМЕ на цих угодах, і сходяться без них", () => {
  /**
   * 🔴 БЕЗ ЦІЄЇ ПОЛОВИНИ ГЕЙТ БЕЗЗУБИЙ. `divergenceKlass` можна зробити «завжди null» —
   * і `#270` вище почервоніє, але це доводить лише, що функція щось повертає. Тут
   * доводиться ЗВʼЯЗОК: назване класом і є те, на чому числа читачів різні.
   */
  const planned = tallyFor(MIXED, "planned");
  const zoneMgr = tallyFor(MIXED, "zoneManager");
  const zoneTeam = tallyFor(MIXED, "zoneTeam");
  assert.deepEqual(planned, { deals: 5, sum: 150_000 }, "🔴 плитка КВП бачить не всю зону");
  assert.deepEqual(zoneMgr, { deals: 2, sum: 60_000 }, "🔴 рядок менеджера бачить не те, що JOIN…AND is_active");
  assert.deepEqual(zoneTeam, { deals: 1, sum: 10_000 }, "🔴 рядок команди бачить не те, що +JOIN teams");
  // Дірка на екрані = рівно сума розбіжності. Не «схоже число», а тотожність.
  assert.equal(planned.sum - zoneTeam.sum,
    scopeDivergence(MIXED).reduce((s, g) => s + g.sum, 0),
    "🔴 розрив плитки й рядків не пояснюється названими класами — отже класи не ті");

  // 🪞 ДРУГА СТОРОНА: приберіть розбіжні — і три читачі мусять збігтись до копійки.
  const clean = MIXED.filter((d) => divergenceKlass(d) === null);
  assert.equal(clean.length, 1, "🔴 фікстура вироджена: після чистки не лишилось на чому перевіряти");
  for (const by of ["zoneManager", "zoneTeam"] as const)
    assert.deepEqual(tallyFor(clean, by), tallyFor(clean, "planned"),
      `🔴 читачі розходяться там, де жодного класу розбіжності немає — ${by}`);
  assert.deepEqual(scopeDivergence(clean), [], "🔴 чиста множина оголошена розбіжною");

  // Предикат `reaches` не має права бути сталим — інакше дві попередні рівності тримає він.
  assert.equal(reaches(NO_TEAM, "zoneManager"), true);
  assert.equal(reaches(NO_TEAM, "zoneTeam"), false,
    "🔴 `reaches` не розрізняє команду — тоді розріз по командах не втрачає нікого за побудовою");
});

/**
 * #270c — БУДИЛЬНИК НА ЖИВОМУ ПРОДІ: плитка «Очікуємо» на КВП == Σ рядків під нею.
 *
 * Сьогодні мовчить (0 угод у кожному класі), і саме тому він потрібен: він задзвонить
 * у день, коли менеджера деактивують раніше, ніж перепризначать його угоди. Симптом без
 * будильника невидимий — жодне окреме число не виглядає дивним.
 *
 * 🧨 САБОТАЖ: `reaches` → `return true` для всіх читачів (тобто «розбіжності не буває»)
 * лишає `#270c` зеленим на живих даних, бо їх сьогодні й немає, — і саме тому
 * властивість тримає фікстура `#270`/`#270b`, а не цей будильник.
 */
test("#270c ЖИВА ЗОНА: три читачі очікувань сходяться, і розбіжність названа поіменно", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const metrics = await import("./metrics.js");
  const { DEAL_NOT_WRITTEN_OFF } = await import("./writeoffScope.js");
  const r = await pool.query<{ kommo_id: string; price: string; manager_id: number | null; active: boolean | null; team_id: number | null }>(
    `SELECT d.kommo_id, d.price, d.manager_id, m.is_active AS active, m.team_id
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) AND ${DEAL_NOT_WRITTEN_OFF}`,
    [metrics.FC_PIPELINES, metrics.EXPECT_ZONE]);
  const deals: ZoneDeal[] = r.rows.map((x) => ({
    kommoId: Number(x.kommo_id), price: Number(x.price),
    managerId: x.manager_id, managerActive: x.active, teamId: x.team_id,
  }));
  // 🈳 Порожня зона — перевіряти нема чого, і це має бути ГУЧНО, а не зелено.
  const skip = emptyPeriodSkip("угод у зоні очікувань (EXPECT_ZONE)", deals.length, "знімок «зараз»");
  if (skip) return t.skip(skip);

  const groups = scopeDivergence(deals);
  const lost = groups.reduce((s, g) => s + g.sum, 0);
  assert.deepEqual(groups.map((g) => `${KLASS_LABEL[g.klass]}: ${g.deals} угод / ${g.sum} ₴`), [],
    `🔴 плитка «Очікуємо» на КВП і Σ рядків команд під нею розійшлись на ${lost} ₴ ` +
    `(перевірено ${deals.length} угод зони). Це НЕ помилка обчислення: три функції очікувань ` +
    `по-різному приєднують менеджера. Рішення про те, куди подіти ці гроші, — власника.`);

  // Дзеркало на живих даних: населення непорожнє, отже нуль вище означає «немає
  // розбіжності», а не «немає кого перевіряти» (правило 16 — негативний результат
  // подається разом із розміром простору).
  assert.ok(deals.length > 0);
  assert.equal(tallyFor(deals, "planned").deals, deals.length);
  // І звірка з ЯДРОМ, а не лише сама із собою: числа мусять збігтись із тими, що на екрані.
  const planned = await metrics.expectedPaymentsByPlanned({});
  const byTeam = await metrics.expectedZoneByScope({}, "team");
  assert.equal(planned.total.deals, tallyFor(deals, "planned").deals,
    "🔴 наша вибірка зони розійшлась із `expectedPaymentsByPlanned` — предикат уже не той самий");
  assert.equal(byTeam.reduce((s, x) => s + x.deals, 0), tallyFor(deals, "zoneTeam").deals,
    "🔴 наша модель `zoneTeam` розійшлась із `expectedZoneByScope` — форму JOIN змінили, а модель ні");
});

/**
 * #270d — ПЛИТКА, ЯКУ ПЕРІОД НЕ ЗВУЖУЄ, МУСИТЬ БУТИ ПІДПИСАНА ЯК ТАКА.
 *
 * 🔴 Три плитки «Життєвого циклу» на КВП виглядають однаково, і дві крайні справді
 * рахуються за вибраний період. Середня («Очікуємо») — знімок УСІЄЇ зони: перемикач
 * періоду на неї не діє взагалі. Без підпису поруч рядок читається як один потік
 * («з відправленого стільки чекає оплати»), яким він не є, — і саме так на екрані
 * зʼявляється розбіжність зі Звітом, де «очікуємо» означає інше (планова дата місяця).
 *
 * 🧨 САБОТАЖ: зняти підпис скоупу з плитки «Очікуємо» (або підписати її «за період») —
 * червоніє тут, бо гейт вимагає, щоб її підпис ВІДРІЗНЯВСЯ від сусідських.
 */
test("#270d плитка «Очікуємо» на КВП підписана скоупом, і він НЕ «за період»", () => {
  const FE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/KvpReportSection.tsx", import.meta.url));
  const src = readFileSync(FE, "utf8");
  // Межа ЗМІСТОВА (кортеж рядка плиток), а не «N рядків від слова» — зсув коду не має
  // ламати гейт і не має ховати дефект (правило 9).
  const row = /\[\["Відправлено",([\s\S]{0,600}?)\]\] as const\)/.exec(src);
  assert.ok(row, "🔴 рядок плиток життєвого циклу не впізнано — гейт втратив предмет, а не підтвердив підпис");
  const tuple = row![0];
  const labels = [...tuple.matchAll(/\["(Відправлено|Очікуємо|Отримано)",\s*"([^"]+)"/g)]
    .map((m) => [m[1], m[2]] as const);
  assert.equal(labels.length, 3, "🔴 не всі три плитки несуть підпис скоупу");
  const byLbl = new Map(labels);
  assert.equal(byLbl.get("Відправлено"), "за період");
  assert.equal(byLbl.get("Отримано"), "за період");
  const aw = byLbl.get("Очікуємо") ?? "";
  assert.notEqual(aw, "за період",
    "🔴 «Очікуємо» підписано періодом, хоч період на неї не діє — це підпис, який бреше");
  assert.ok(/без прив|уся зона|вся зона/i.test(aw),
    `🔴 підпис «Очікуємо» не каже, що це УСЯ зона без прив'язки до дати: «${aw}»`);
  // ⓘ мусить казати те саме словами — інакше правило живе лише в одному місці.
  assert.ok(/ПЕРІОД НА НЕЇ НЕ ДІЄ/.test(src),
    "🔴 підказка ⓘ більше не називає, що період на цю плитку не діє");
});
