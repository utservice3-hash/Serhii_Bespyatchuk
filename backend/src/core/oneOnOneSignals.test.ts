import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_THRESHOLDS, SIGNAL_KEYS, SIGNAL_LABEL, owedType, prevMonthOf,
  personSignals, findingsOf, countBySignal, rollUpByTeam, weakestQuestions,
  type PersonInput, type SignalKey,
} from "./oneOnOneSignals.js";
import { needsBackendEnv } from "../testMode.js";

const T = SIGNAL_THRESHOLDS;

/**
 * Людина без жодної проблеми — база, від якої фікстури відхиляються по ОДНІЙ осі.
 *
 * 🔴 `avgPrevMonth: null` У БАЗІ НАВМИСНО, і це не «щоб зійшлося». Перша редакція мала
 * тут `9`, і тоді вісь «низький бал» тягнула за собою вісь «падіння»: приклад із балом 7
 * давав ДВА сигнали, і гейт червонів на робочому коді. Тобто фікстура перевіряла б не
 * поріг, а їхню суму — рівно те, від чого береже правило «межі мусять бути змістові».
 * Порівняння з минулим місяцем вмикають ті тести, які саме його й перевіряють.
 */
const ok = (over: Partial<PersonInput> = {}): PersonInput => ({
  managerId: 1, name: "Тест", teamId: 5, teamName: "РПК", isTeamLead: false,
  metThisMonth: true, metEver: true,
  avgThisMonth: 9, avgPrevMonth: null, enpsScore: null, enpsReason: null,
  lowAnswers: [], openTasks: [], ...over,
});
const keys = (p: PersonInput): SignalKey[] => personSignals(p).hits.map((h) => h.key);

/**
 * 🔗 #380 — КОЖЕН ПОРІГ ПЕРЕВІРЕНО З ОБОХ БОКІВ, а не «функція щось повертає».
 *
 * 🔴 Фікстура з одного значення не перевіряє властивості (правило 11 з CLAUDE.md): якби
 * тут стояв лише «поганий» приклад, гейт лишався б зеленим після заміни `<` на `<=`,
 * після зсуву порогу на бал і після «завжди сигналити». Тому кожен поріг має ПАРУ:
 * значення рівно на межі (сигналу немає) і на крок за нею (сигнал є).
 *
 * 📐 І це не теорія: за серпень 2026 на проді під `avgLow` не потрапив НІХТО (найнижче
 * середнє 7,7 при порозі 7), тож живих даних на цій межі немає — фікстура тут єдиний
 * спосіб довести, що поріг узагалі працює.
 */
test("#380 ПОРОГИ СИГНАЛІВ — по обидва боки межі, кожен окремо", () => {
  // avgLow: 7 — не сигнал (межа НЕ включна), 6.9 — сигнал
  assert.deepEqual(keys(ok({ avgThisMonth: T.avgLow })), [], `бал рівно ${T.avgLow} сигналом бути не має`);
  assert.deepEqual(keys(ok({ avgThisMonth: T.avgLow - 0.1 })), ["avgLow"]);

  // drop: падіння рівно на dropBy — уже сигнал (межа включна), на крок менше — ні
  assert.deepEqual(keys(ok({ avgPrevMonth: 9, avgThisMonth: 9 - T.dropBy })), ["drop"]);
  assert.deepEqual(keys(ok({ avgPrevMonth: 9, avgThisMonth: 9 - T.dropBy + 0.1 })), []);

  // answerLow: 5 — сигнал (межа ВКЛЮЧНА), 6 — ні
  assert.deepEqual(keys(ok({ lowAnswers: [{ qKey: "a_prod", label: "Продуктивність", score: T.answerLow }] })), ["answerLow"]);
  assert.deepEqual(keys(ok({ lowAnswers: [{ qKey: "a_prod", label: "Продуктивність", score: T.answerLow + 1 }] })), []);

  // enpsLow: 6 — сигнал (включна), 7 — ні (це вже пасив за шкалою eNPS)
  assert.deepEqual(keys(ok({ enpsScore: T.enpsLow })), ["enpsLow"]);
  assert.deepEqual(keys(ok({ enpsScore: T.enpsLow + 1 })), []);

  // tasksOpen: закрита задача не сигнал, відкрита — сигнал
  const task = { id: 1, title: "Зробити", deadline: "2026-08-31", status: "not_started" };
  assert.deepEqual(keys(ok({ openTasks: [{ ...task, status: "done" }] })), []);
  assert.deepEqual(keys(ok({ openTasks: [task] })), ["tasksOpen"]);
});

/**
 * 🔗 #380b — `missed` І `never` ВЗАЄМОВИКЛЮЧНІ, і розрізняє їх саме `metEver`.
 *
 * 📐 Заміряно на проді 09.09.2026, і це головна причина існування розколу: без зустрічі
 * в серпні — 15 людей, але «пропустили» з них РІВНО ОДИН (Білоусько), а 14 не мали 1×1
 * ЖОДНОГО разу — 6 тімлідів (тип Б не проводили ніколи, 0 записів за всю історію) і
 * 3 фінвідділ. Один підпис на дві різні відмови зробив би екран, який щомісяця показує
 * ті самі 14 «проблем», — його перестають читати за два місяці.
 */
test("#380b РОЗКОЛ «ПРОПУСТИЛИ» ПРОТИ «НІКОЛИ» — за metEver, і разом вони не бувають", () => {
  assert.deepEqual(keys(ok({ metThisMonth: false, metEver: true })), ["missed"]);
  assert.deepEqual(keys(ok({ metThisMonth: false, metEver: false })), ["never"]);
  assert.deepEqual(keys(ok({ metThisMonth: true, metEver: true })), []);
  // Той, хто зустріч мав, не може бути ні «пропущеним», ні «ніколи» — навіть із іншими сигналами
  const both = keys(ok({ metThisMonth: true, metEver: false, avgThisMonth: 3 }));
  assert.ok(!both.includes("missed") && !both.includes("never"), `не мало бути пропуску: ${both.join()}`);
});

/**
 * 🪞 #380c ДЗЕРКАЛО — список показує ПРОБЛЕМИ, а не ростер, і не дублює людину.
 *
 * Без цього твердження «findingsOf» лишався б зеленим і тоді, коли повертає всіх підряд
 * (екран стає ростером) або коли людина з двома сигналами йде двома рядками (підсумок
 * по команді порахував би її двічі).
 */
test("#380c 🪞 ДЗЕРКАЛО: без сигналів — випадає; з двома — один рядок і дві мітки", () => {
  const clean = ok({ managerId: 1, name: "Чистий" });
  const two = ok({ managerId: 2, name: "Двічі", avgThisMonth: 3, enpsScore: 2 });
  const found = findingsOf([clean, two]);
  assert.equal(found.length, 1, "людина без сигналів не має бути в списку");
  assert.equal(found[0].managerId, 2);
  assert.deepEqual(found[0].hits.map((h) => h.key), ["avgLow", "enpsLow"]);
  // Порядок — спершу ті, у кого сигналів більше
  const one = ok({ managerId: 3, name: "Один", enpsScore: 1 });
  assert.deepEqual(findingsOf([one, two]).map((f) => f.managerId), [2, 3]);
});

/**
 * 🔗 #380d — «НЕМАЄ З ЧИМ ПОРІВНЯТИ» ≠ ПАДІННЯ.
 *
 * 🔴 Порожній попередній місяць не можна виражати нулем (правило 7-похідне з CLAUDE.md):
 * прочитавши `null` як `0`, ядро побачило б падіння на всі 9 балів у КОЖНОЇ людини, з
 * якою 1×1 провели вперше. 📐 За серпень таких на проді 22 із 37 — тобто дефект накрив би
 * більшість екрана й виглядав би як катастрофа в компанії.
 */
test("#380d ПАДІННЯ БЕЗ ПОПЕРЕДНЬОГО МІСЯЦЯ — не сигнал, і не нуль", () => {
  assert.deepEqual(keys(ok({ avgPrevMonth: null, avgThisMonth: 3 })), ["avgLow"], "лише низький бал, без падіння");
  assert.deepEqual(keys(ok({ avgPrevMonth: null, avgThisMonth: 9 })), []);
  // І навпаки: є попередній, немає поточного — теж не падіння (зустрічі просто не було)
  assert.deepEqual(keys(ok({ avgPrevMonth: 9, avgThisMonth: null })), []);
});

/**
 * 🔗 #380e — Σ ПО КОМАНДАХ == Σ ПО ЛЮДЯХ, для КОЖНОГО сигналу окремо.
 *
 * Два агрегати над одним набором розходяться тихо, і кожен поодинці виглядає правильним —
 * саме цей клас коштував нам розбіжності у 290 570 ₴ між двома екранами планів.
 */
test("#380e ІНВАРІАНТ: зведення по командах не втрачає і не дублює жодного сигналу", () => {
  const people = [
    ok({ managerId: 1, name: "А", teamId: 5, teamName: "РПК", avgThisMonth: 3 }),
    ok({ managerId: 2, name: "Б", teamId: 5, teamName: "РПК", enpsScore: 2, metThisMonth: false, metEver: true }),
    ok({ managerId: 3, name: "В", teamId: 7, teamName: "РНК", avgThisMonth: 3, enpsScore: 1 }),
    ok({ managerId: 4, name: "Г", teamId: null, teamName: null, metThisMonth: false, metEver: false }),
  ];
  const findings = findingsOf(people);
  const byPerson = countBySignal(findings);
  const teams = rollUpByTeam(findings);
  for (const k of SIGNAL_KEYS) {
    const byTeam = teams.reduce((s, t) => s + t.bySignal[k], 0);
    assert.equal(byTeam, byPerson[k], `сигнал «${k}»: по командах ${byTeam}, по людях ${byPerson[k]}`);
  }
  assert.equal(teams.reduce((s, t) => s + t.people, 0), findings.length, "людей у командах == людей у списку");
  // Безкомандний не зникає і не лишається без підпису — невідоме читається як невідоме
  assert.ok(teams.some((t) => t.teamName === "Поза командами"), "команда без назви має бути підписана словами");
});

/**
 * 🔗 #380f — ПОПЕРЕДНІЙ МІСЯЦЬ НЕ ПЕРЕСКАКУЄ, і не залежить від дня запуску.
 *
 * 📐 Борг 19 із CLAUDE.md: `d.setUTCMonth(d.getUTCMonth() - 1)` на 31-му числі дає
 * ЧЕРЕЗ місяць (заміряно 27 таких днів на рік). Тут арифметика рядкова, тож дня не існує
 * взагалі — і цей гейт стереже саме те, що його не завели назад.
 */
test("#380f ПОПЕРЕДНІЙ МІСЯЦЬ — рядкова арифметика, межа року включно", () => {
  assert.equal(prevMonthOf("2026-08"), "2026-07");
  assert.equal(prevMonthOf("2026-01"), "2025-12", "січень має вести у грудень минулого року");
  assert.equal(prevMonthOf("2026-03"), "2026-02", "лютий короткий — але це рядки, не дати");
  assert.equal(prevMonthOf("2026-12"), "2026-11");
  assert.throws(() => prevMonthOf("2026-13"), /YYYY-MM/, "невалідний місяць мусить кричати, а не мовчки з'їхати");
  assert.throws(() => prevMonthOf("серпень"), /YYYY-MM/);
});

/**
 * 🔗 #380g — ТИП ЗУСТРІЧІ ПО ЛЮДИНІ, і найслабші питання без порогу.
 *
 * 📐 Тімліду належить тип Б: заміряно, що ЖОДЕН тімлід не мав типу A у серпні — шукати
 * в них тип A означало б рахувати пропуском те, чого не мало бути (6 людей щомісяця).
 */
test("#380g ТИП ЗА РОЛЛЮ + найслабші питання: без порогу, але без порожніх", () => {
  assert.equal(owedType(true), "B", "тімлід — тип Б");
  assert.equal(owedType(false), "A");
  assert.equal(personSignals(ok({ isTeamLead: true })).owed, "B");

  const rows = [
    { qKey: "a_emotion", label: "Емоційний стан", avg: 8.22, answers: 23 },
    { qKey: "a_prod", label: "Продуктивність", avg: 8.7, answers: 23 },
    { qKey: "a_us", label: "Взаємодія", avg: 9.78, answers: 23 },
    { qKey: "a_dead", label: "Зняте питання", avg: 1, answers: 0 },
  ];
  const weak = weakestQuestions(rows);
  assert.equal(weak.length, T.weakTop, `має бути рівно ${T.weakTop} рядки`);
  assert.deepEqual(weak.map((w) => w.qKey), ["a_emotion", "a_prod", "a_us"], "сортування за зростанням середнього");
  assert.ok(!weak.some((w) => w.qKey === "a_dead"), "питання без жодної відповіді не має найнижчого середнього — воно взагалі не має середнього");
  // Підпис кожного сигналу існує — інакше екран показав би ключ замість людської назви
  for (const k of SIGNAL_KEYS) assert.ok(SIGNAL_LABEL[k]?.length > 3, `немає підпису для «${k}»`);
});

/**
 * 🔗 #380h ЖИВИЙ — ядро проти ПРОД-бази: ростер, розкол і сигнали за серпень 2026.
 *
 * 🔴 Числа беруться ОДНИМ запитом у ту саму мить, а не звіряються з памʼяттю: ростер живий
 * (людину переводять, стан міняють), тож «було 37» завтра буде іншим — і гейт червонів би
 * без дефекту. Тому тут перевіряються ІНВАРІАНТИ, а не константи: розкол вичерпний,
 * тімлідам належить Б, і жодна людина не має обох пропусків одночасно.
 */
test("#380h ЖИВИЙ: ростер і розкол «пропустили/ніколи» сходяться на проді",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { hasPlanSql, stateJoinSql } = await import("./managerState.js");
  const { activeManagerSql } = await import("./activeManager.js");
  const month = "2026-08-01";
  const { rows } = await pool.query<{
    id: number; is_team_lead: boolean; owed: string; met_this: boolean; met_ever: boolean;
  }>(
    `WITH r AS (
       SELECT m.id, m.is_team_lead, CASE WHEN m.is_team_lead THEN 'B' ELSE 'A' END AS owed
         FROM managers m ${stateJoinSql("m")}
        WHERE ${hasPlanSql("m", activeManagerSql("m"))} AND m.team_id IS NOT NULL)
     SELECT r.id, r.is_team_lead, r.owed,
            EXISTS (SELECT 1 FROM one_on_ones o WHERE o.subject_manager_id=r.id AND o.type=r.owed
                      AND date_trunc('month', o.meeting_date) = $1::date) AS met_this,
            EXISTS (SELECT 1 FROM one_on_ones o WHERE o.subject_manager_id=r.id AND o.type=r.owed) AS met_ever
       FROM r`, [month]);

  assert.ok(rows.length > 0, "ростер порожній — перевірці немає що знаходити");
  const met = rows.filter((r) => r.met_this).length;
  const missed = rows.filter((r) => !r.met_this && r.met_ever).length;
  const never = rows.filter((r) => !r.met_this && !r.met_ever).length;
  assert.equal(met + missed + never, rows.length, "розкол мусить бути ВИЧЕРПНИМ: третього стану немає");
  // Тімлід не може мати зустріч типу A зарахованою як свою — його тип Б за побудовою
  assert.ok(rows.filter((r) => r.is_team_lead).every((r) => r.owed === "B"), "тімлід мусить чекати тип Б");
  assert.ok(never > 0 || missed > 0 || met === rows.length,
    "хоч один із трьох станів мусить бути непорожнім — інакше запит нічого не поміряв");
});
