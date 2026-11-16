import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE, planGraceSkip, emptyPeriodSkip, monthStartSkip } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

/**
 * #65 — СМУГИ ПРОГРЕСУ: ЩО МОЖНА СКЛАДАТИ, А ЩО НІ.
 *
 * 🔴 ЦЕНТРАЛЬНЕ ЧИСЛО ЦІЄЇ ФІЧІ, ЗАМІРЯНЕ 07.08.2026: у Антипенка **35 088 ₴**
 * перенесеного з минулого місяця ОДНОЧАСНО мають планову дату оплати в серпні.
 * Тобто «перенесене» і «очікується цього місяця» — множини, що ПЕРЕТИНАЮТЬСЯ на
 * 69% (35 088 із 50 876). Намалювати їх сусідніми сегментами накопичувальної
 * смуги означало б показати ці гроші ДВІЧІ й завищити прогноз — число, яке
 * власник читає щодня.
 *
 * Тому: місячна смуга має РІВНО ДВА накопичувальні сегменти (отримано +
 * очікується цього місяця), а риска прогнозу дорівнює `projected`, який ядро
 * рахує як `fact + expectThisMonth`. Гейт тримає обидві межі.
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

test("#65 прогноз == факт + очікується цього місяця, без carryover", needsApi(), async (t) => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const ym = kyivMonthBounds().ym;
  const to = kyivMonthBounds().to;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const b = await r.json() as { managers: { name: string; fact: number; plan: number;
    expectThisMonth: number; projected: number; monthInProgress: boolean }[] };

  const live = b.managers.filter((m) => m.plan > 0 && m.monthInProgress);
  /**
   * 🗓 ПЛАНІВ НЕМАЄ — СКІП ЛИШЕ У ВІКНІ ЗАВЕДЕННЯ (перші 2 робочі дні, доменний
   * факт власника). Після вікна `planGraceSkip` віддає null, гейт біжить далі й
   * падає власним вироком — саме він і є сигнал «плани забули завести».
   */
  const graced = planGraceSkip("менеджерів із планом у поточному місяці", live.length);
  if (graced) return t.skip(graced);
  assert.ok(live.length >= 5,
    `🔴 лише ${live.length} менеджерів із планом у поточному місяці — смугу нема на чому перевірити`);

  const bad = live
    .filter((m) => Math.abs(m.projected - (m.fact + m.expectThisMonth)) > 1)
    .map((m) => `${m.name}: projected ${m.projected} ≠ ${m.fact} + ${m.expectThisMonth}`);
  assert.deepEqual(bad, [],
    "🔴 РИСКА ПРОГНОЗУ РОЗІЙШЛАСЬ ІЗ СЕГМЕНТАМИ. Смуга малює факт + очікування, а риска "
    + "стоїть на іншому числі — на екрані зʼявиться третя правда.");

  // ⚠️ Порожній результат = ПРОВАЛ: доводимо, що очікування взагалі є.
  assert.ok(live.some((m) => m.expectThisMonth > 0),
    "🔴 у жодного менеджера немає очікувань цього місяця — помаранчевий сегмент ніде не видно, "
    + "і гейт нічого не довів");
});

/**
 * #65c — ТРИ СЕГМЕНТИ НЕ ПЕРЕТИНАЮТЬСЯ, І ЇХНЯ Σ НЕ ПЕРЕВИЩУЄ ПОКРИТТЯ.
 *
 * 🔴 Множини розділені ЗА ПОБУДОВОЮ: (1) гроші вже прийшли — статус; (2) дата
 * оплати є і вона в цьому місяці; (3) дати немає. Угода не може одночасно мати
 * й не мати планову дату. Гейт перевіряє це на живих даних: якщо хтось колись
 * замінить предикат сегмента 3 на «все, що чекає», Σ миттєво перевищить когорту.
 *
 * ⚠️ Заміряно 07.08: «чекає без дати» у ЗОНІ ВИЗНАННЯ = 0 в обох перевірених —
 * саме тому сегмент 3 береться з КОГОРТИ (ті гроші стоять на стадіях поза зоною).
 */
test("#65c три сегменти місяця не перетинаються", needsApi(), async (t) => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const ym = kyivMonthBounds().ym;
  const to = kyivMonthBounds().to;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const b = await r.json() as { managers: { name: string; plan: number; fact: number;
    expectThisMonth: number; expectNextMonth: number;
    cohort: { sum: number; awaitNoDateSum: number; awaitDatedSum: number } }[] };

  const live = b.managers.filter((m) => m.plan > 0 && (m.cohort?.sum ?? 0) > 0);
  /**
   * 🗓 ПЛАНІВ НЕМАЄ — СКІП ЛИШЕ У ВІКНІ ЗАВЕДЕННЯ (перші 2 робочі дні, доменний
   * факт власника). Після вікна `planGraceSkip` віддає null, гейт біжить далі й
   * падає власним вироком — саме він і є сигнал «плани забули завести».
   */
  const graced3 = planGraceSkip("менеджерів із планом і рухом", live.length);
  if (graced3) return t.skip(graced3);
  /* 🗓 01.10.2026: на 1-ше число менеджерів із планом і рухом було 2 (не нуль), і `planGraceSkip` мовчав —
     гейт падав на «замало». У вікні перших 2 робочих днів «замало» — теж законний стан (`monthStartSkip`). */
  const early3 = monthStartSkip("менеджерів із планом і рухом", live.length, 3, ym);
  if (early3) return t.skip(early3);
  assert.ok(live.length >= 3, `🔴 лише ${live.length} менеджерів із планом і рухом — перевіряти нема на чому`);

  const bad: string[] = [];
  for (const m of live) {
    // Сегмент 3 не може перевищувати все, що когорта вважає неоплаченим без дати.
    if (m.cohort.awaitNoDateSum > m.cohort.sum) {
      bad.push(`${m.name}: «без дати» ${m.cohort.awaitNoDateSum} > усього відправлено ${m.cohort.sum}`);
    }
    // Дата в НАСТУПНОМУ місяці в сегменти не входить — інакше місяць з'їдав би чужі гроші.
    if (m.expectNextMonth > 0 && m.expectThisMonth === m.expectNextMonth && m.expectNextMonth > 1000) {
      bad.push(`${m.name}: expectThisMonth == expectNextMonth (${m.expectNextMonth}) — межа місяця не тримає`);
    }
  }
  assert.deepEqual(bad, [], "🔴 СЕГМЕНТИ ПЕРЕТИНАЮТЬСЯ АБО ЛІЗУТЬ У ЧУЖИЙ МІСЯЦЬ:\n  " + bad.join("\n  "));

  // ⚠️ Порожній результат = ПРОВАЛ: третій сегмент має бути видно хоч у когось.
  /* 🗓 01.10.2026 (викат 75251a7): увечері 1-го числа менеджерів уже вистачило, але когорта місяця ще не мала
     жодного «чекає без дати» — той самий календар рядком нижче. Перетин сегментів УЖЕ перевірено вище; скіп
     лише у вікні 2 робочих днів поточного місяця (`monthStartSkip`), після нього — падіння. */
  const early3rd = monthStartSkip("менеджерів із «чекає без дати»", live.filter((m) => m.cohort.awaitNoDateSum > 0).length, 1, ym);
  if (early3rd) return t.skip(early3rd);
  assert.ok(live.some((m) => m.cohort.awaitNoDateSum > 0),
    "🔴 у жодного менеджера немає «чекає без дати» — третій сегмент ніде не видно, "
    + "і гейт про нього нічого не довів");
});

/**
 * #7728 — СМУГА ТИЖНЯ — ЛИШЕ «ОТРИМАНО», ВІДПРАВЛЕНЕ — У «ГРОШАХ ТИЖНЯ»; МІСЯЧНА — ЛИШЕ ФАКТ.
 * Наступник `#65b` (13.11.2026, макет-ремейк): другої смужки «відправлено» на картці більше
 * немає — її число переїхало першим рядком блоку «Гроші тижня» (`cohort.sum`, клікабельне).
 * Головне твердження те саме: «отримано» й «відправлено» НЕ склеєні в одне число, і
 * в місячну смугу не домішано carryover.
 * 🧨 Червоніє, якщо скласти `week.fact` з `cohort` або прибрати «відправлено» з «Грошей тижня».
 */
test("#7728 смуга тижня — лише отримано; відправлене — у «Грошах тижня»; не склеєні; у місячній смузі немає carryover", async () => {
  const src = strip(await readFile(FE, "utf8"));
  const card = src.split("function MgrStrip(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(card.length > 0, "🔴 картки менеджера немає");
  assert.match(card, /<b>\{fmt\(m\.week\.fact\)\}<\/b> з \{fmt\(m\.week\.target\)\}/, "🔴 смуга тижня показує не «отримано»");
  assert.ok(!/m\.week\.fact\s*\+\s*m\.cohort/.test(src) && !/m\.cohort\.sum\s*\+\s*m\.week\.fact/.test(src),
    "🔴 «отримано» і «відправлено» СКЛАДЕНІ в одне число — це різні множини");
  const wm = src.split("function WeekMoney(")[1]?.split("\nfunction ")[0] ?? "";
  assert.match(wm, /<Link kind="dispatched" lbl=\{`відправлено/, "🔴 «відправлено» зникло з «Грошей тижня» — роботу з перевиконанням знову не видно");
  assert.match(wm, /val=\{`\$\{fmt\(c\.sum\)\} ₴`\}/, "🔴 «відправлено» бере не `cohort.sum`");
  assert.match(card, /width: `\$\{Math\.min\(100, pct\)\}%`, background: sc/, "🔴 місячна смуга малює не факт ÷ план");
  assert.ok(!/carry/i.test(card), "🔴 у картку додали carryover — він перетинає очікуване на 69%");
});

/**
 * #7734 — ОЧІКУВАННЯ ЦЬОГО МІСЯЦЯ — ПУНКТИРОМ НА СМУЗІ, ПІСЛЯ ФАКТУ, ЛИШЕ ДЛЯ ПОВНОГО ПОТОЧНОГО МІСЯЦЯ.
 * Сергій 16.11.2026: «не виведені очікування, їх треба додати до шкали прогресу, пунктиром, як і раніше
 * було … очікування на цей місяць». Сегмент — `expectThisMonth` (планова дата в цьому місяці), стоїть
 * від кінця факту, заштрихований; з фактом у ЧИСЛО не складається. І на картці, і в плитці «Команда».
 * 🧨 Червоніє, якщо прибрати сегмент з картки чи плитки, взяти не `expectThisMonth` або малювати поза поточним місяцем.
 */
test("#7734 очікування цього місяця — пунктиром на смузі після факту (картка і «Команда»), лише в поточному місяці", async () => {
  const src = strip(await readFile(FE, "utf8"));
  const seg = src.split("function ExpectSeg(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(seg.length > 0, "🔴 компонента сегмента очікувань немає");
  assert.match(seg, /const from = Math\.min\(100, Math\.max\(0, \(fact \/ plan\) \* 100\)\)/, "🔴 сегмент починається не з кінця факту");
  assert.match(seg, /\(\(fact \+ expect\) \/ plan\) \* 100/, "🔴 кінець сегмента — не факт + очікуване на тій самій шкалі");
  assert.match(seg, /repeating-linear-gradient\(135deg/, "🔴 очікуване не пунктиром — злиється з фактом");
  const card = src.split("function MgrStrip(")[1]?.split("\nfunction ")[0] ?? "";
  assert.match(card, /\{m\.monthInProgress && <ExpectSeg fact=\{m\.fact\} expect=\{m\.expectThisMonth\} plan=\{m\.plan\}/,
    "🔴 на картці немає очікувань цього місяця (або вони малюються поза поточним місяцем)");
  const g = src.split("function Glance(")[1]?.split("\nfunction ")[0] ?? "";
  assert.match(g, /\{monthInProgress && <ExpectSeg fact=\{g\.fact\} expect=\{g\.expectThisMonth\} plan=\{g\.plan\}/,
    "🔴 у плитці «Команда» немає очікувань цього місяця");
  assert.match(src, /monthInProgress=\{mode === "month" && data\.scope\.isCurrent\}/, "🔴 плитка малює очікування не лише в поточному місяці");
  // `fact={m.fact + m.expectThisMonth}` у другого сегмента — ПОЗИЦІЯ на смузі (16.11, «без дати» після «дата є»),
  // а не показане число; ловимо саме число.
  assert.ok(!/(?<!fact=\{)m\.fact\s*\+\s*m\.expectThisMonth/.test(src) && !/(?<!fact=\{)g\.fact\s*\+\s*g\.expectThisMonth/.test(src),
    "🔴 факт і очікуване складено в одне число");
});

/**
 * #7735 — КАРТКА МЕНЕДЖЕРА ПОВЕРНУЛА ДАНІ, ЯКІ БУЛИ ДО РЕМЕЙКУ (Роман 16.11.2026: «повертай все», макет
 * `kartka-maket`). Без кліку: «чекає без дати» на смузі, прогноз, легенда сум, «не покрито», «треба ₴/д ·
 * прогноз», «очікуємо цей · наст. міс», смужка «Відправлено» тижня з ТИЖНЕВОЇ когорти, «нов · пост»,
 * «₴ авто», «отримано ₴», тижнева гістограма; у розкритті — «📅 Показники» за період.
 * 🧨 Червоніє, якщо прибрати будь-що з цього або взяти «Відправлено» не з тижневої когорти.
 */
test("#7735 картка повернула дані до ремейку: без дати, прогноз, легенда, треба/прогноз, очікуємо, «Відправлено» тижня, нов/пост, ₴ авто, отримано, гістограма, «Показники»", async () => {
  const src = strip(await readFile(FE, "utf8"));
  const card = src.split("function MgrStrip(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(card.length > 0, "🔴 картки менеджера немає");
  const need: [RegExp, string][] = [
    [/<ExpectSeg fact=\{m\.fact \+ m\.expectThisMonth\} expect=\{noDate\} plan=\{m\.plan\} light/, "пунктир «чекає без дати» після «дата є»"],
    [/const noDate = m\.cohort\?\.awaitNoDateSum \?\? 0;/, "«без дати» з когорти, як до ремейку"],
    [/className="rv-fc" style=\{\{ left: `\$\{Math\.min\(100, \(m\.projected \/ m\.plan\) \* 100\)\}%` \}\}/, "риска прогнозу"],
    [/className="rv-leg"/, "легенда з сумами"],
    [/не покрито \{fmt\(uncovered\)\} ₴/, "«не покрито»"],
    [/треба <b>\{fmt\(m\.needPerDay\)\} ₴\/д<\/b> \(\{remWd\} дн\.\)/, "«треба ₴/д»"],
    [/прогноз — лише для повного поточного місяця/, "чесний підпис, коли прогнозу немає"],
    [/очікуємо <b style=\{\{ color: GREEN \}\}>\{k\(m\.expectThisMonth\)\}<\/b> цей · <b>\{k\(m\.expectNextMonth\)\}<\/b> наст\. міс/, "«очікуємо цей · наст. міс»"],
    [/поза обраним періодом/, "підпис форварду «поза обраним періодом»"],
    [/const sent = mWeek\?\.cohort\?\.sum \?\? 0, sentCars = mWeek\?\.cohort\?\.deals \?\? 0;/, "«Відправлено» тижня з ТИЖНЕВОЇ когорти"],
    [/Відправлено · <b>\{fmt\(sent\)\} ₴<\/b>/, "смужка «Відправлено»"],
    [/роботи зроблено на \{sentPct\}% тижневого плану/, "«роботи зроблено на X% тижневого плану»"],
    [/<small>\{m\.new\} нов · \{m\.rep\} пост<\/small>/, "«нов · пост» під створено"],
    [/<small>\{k\(m\.kpi\.dispatch\.revenue \?\? 0\)\} ₴<\/small>/, "«₴» під авто"],
    [/<b>\{fmt\(m\.fact\)\}<\/b>отримано ₴/, "окреме «отримано ₴»"],
    [/className="rv-spark"/, "гістограма отриманого по тижнях"],
    [/<h4>📅 Показники <small>факт за/, "блок «📅 Показники» у розкритті"],
  ];
  const lost = need.filter(([re]) => !re.test(card)).map(([, l]) => l);
  assert.deepEqual(lost, [], "🔴 з картки знову зникло: " + lost.join("; "));
  assert.ok(!/m\.week\.fact\s*\+\s*(m|mWeek)\??\.cohort/.test(card), "🔴 «отримано» тижня склеєно з «відправлено»");
});

