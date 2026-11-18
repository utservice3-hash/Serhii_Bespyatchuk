import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * #7893 / #7893b — РЕЄСТР ПОКАЗНИКІВ ЗВІТУ: ЖОДЕН НЕ ЗНИКАЄ МОВЧКИ (18.11.2026).
 *
 * 🧭 ЗВІДКИ. TOP Weekly 16.11.2026: після ремейку Звіту (13.11, `e638816`) тімліди на своїй зустрічі
 * не знайшли частини даних. Сергій: «якщо ми змінюємо вигляд, то залишаємо функціонал»; Саша:
 * «зафіксувати всі показники, які були, … щоб він по всіх таблицях пройшовся, перевірив». «Роби»
 * Романа 18.11 (план `meeting-1611-1-plan.md`, крок 1).
 *
 * 📋 ЩО ЦЕ. Перелік усього, що Звіт показує: шапка, чотири плитки, блоки над списком, картка
 * менеджера, кожна колонка таблиці. Перелік живе ТУТ, у тесті, як `testManifest.ts`: застосунок
 * його не читає, і саме тому він не може тихо «підлаштуватись» під зміну екрана. Змінити склад
 * Звіту = свідомо змінити цей файл.
 *
 * 🔴 ДВА БОКИ, ІНАКШЕ РЕЄСТР ЗАРОСТАЄ.
 *  - `#7893`: кожен показник із `REPORT_INDICATORS` є в джерелі екрана, а колонки таблиці збігаються
 *    з реєстром колонок фронта В ОБИДВА БОКИ (зникла → червоне; нова без запису тут → теж червоне).
 *  - `#7893b`: прибране свідомо лежить у `REMOVED_INDICATORS` з автором і датою — і СПРАВДІ прибране.
 *    Запис про те, що досі на екрані, — брехня реєстру: під ним наступне справжнє зникнення пройшло б
 *    мовчки (той самий принцип, що в `RETIRED_GATES`).
 *
 * ⚠️ МЕЖА. Маркер — це текст джерела, тобто гейт доводить «код малює цей показник», а не «на екрані
 * правильне число». Числа стережуть свої гейти (`#7735` — картка, `#81…` — таблиця). Браузера в
 * наборі немає; приймання очима — на проді.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FE = path.join(ROOT, "frontend", "src", "pages", "dashboard");
const FILES = {
  plan: path.join(FE, "sections", "ReportPlanSection.tsx"),
  table: path.join(FE, "sections", "ReportTableSection.tsx"),
} as const;
type FileKey = keyof typeof FILES;

const codeOnly = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const src = (f: FileKey) => codeOnly(readFileSync(FILES[f], "utf8"));
/** Тіло функції-компонента — щоб показник картки не «знаходився» в плитці з тим самим словом. */
const fnBody = (f: FileKey, name: string) => src(f).split(`function ${name}(`)[1]?.split("\nfunction ")[0] ?? "";

interface Indicator {
  /** Що бачить людина — словами екрана. */
  label: string;
  where: "шапка" | "плитка «Команда»" | "плитка «Очікуємо»" | "плитка «Авто й ціна»" | "плитка дня" | "над списком" | "картка" | "розкриття картки";
  file: FileKey;
  /** Компонент, у тілі якого шукати (порожнє — увесь файл). */
  fn?: string;
  marker: RegExp;
}

/** 📋 УСЕ, ЩО ЗВІТ ПОКАЗУЄ, КРІМ КОЛОНОК ТАБЛИЦІ (вони нижче окремим списком). Стан на 18.11.2026. */
const REPORT_INDICATORS: Indicator[] = [
  // ── шапка ──
  { label: "період: День · Тиждень · Місяць · Період", where: "шапка", file: "plan", marker: /<PeriodStepper state=\{navState\}/ },
  { label: "вибір команди (адмін)", where: "шапка", file: "plan", marker: /<option value="">Усі команди<\/option>/ },
  { label: "вигляд: Картки / Таблиця", where: "шапка", file: "plan", marker: /\{v === "cards" \? "Картки" : "Таблиця"\}/ },
  // ── плитка «Команда» ──
  { label: "факт з плану команди", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /\{fmt\(g\.fact\)\} <small>з \{fmt\(g\.plan\)\} ₴<\/small>/ },
  { label: "кільце % плану, розклад «успішно + оплачено» в підказці", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /= успішно реалізовано \(виграно 142\)/ },
  { label: "рядок «= успішно … + оплачено … · чек … ₴» (повернуто 18.11)", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /= успішно \{k\(g\.factSuccess\)\} \+ оплачено \{k\(g\.factPaid\)\} · чек \{g\.avgCheck == null/ },
  { label: "очікування цього місяця пунктиром на смузі", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /<ExpectSeg fact=\{g\.fact\} expect=\{g\.expectThisMonth\}/ },
  { label: "очікування цього тижня пунктиром на смузі (додано 18.11, пункт 2)", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /<ExpectSeg fact=\{g\.fact\} expect=\{g\.expectInPeriod\}/ },
  { label: "рядок «з очікуваннями … ₴ · N% плану» (додано 18.11, пункт 2)", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /з очікуваннями <b>\{fmt\(withExp\)\} ₴<\/b>/ },
  { label: "чипи станів: зрив · відстає · у нормі", where: "плитка «Команда»", file: "plan", fn: "Glance", marker: /s === "r" \? "зрив" : s === "a" \? "відстає" : "у нормі"/ },
  // ── плитка «Очікуємо» ──
  { label: "очікуємо за план. датою — цей місяць", where: "плитка «Очікуємо»", file: "plan", fn: "Glance", marker: /\{fmt\(g\.expectThisMonth\)\} <small>₴ цей міс<\/small>/ },
  { label: "на цей тиждень (режим «Тиждень», додано 18.11)", where: "плитка «Очікуємо»", file: "plan", fn: "Glance", marker: /<span>на цей тиждень<\/span>/ },
  { label: "наступний місяць", where: "плитка «Очікуємо»", file: "plan", fn: "Glance", marker: /<span>наступний місяць<\/span><b>\{fmt\(g\.expectNextMonth\)\} ₴<\/b>/ },
  { label: "з минулих місяців", where: "плитка «Очікуємо»", file: "plan", fn: "Glance", marker: /<span>з минулих місяців<\/span>/ },
  // ── плитка «Авто й ціна» ──
  { label: "авто за період", where: "плитка «Авто й ціна»", file: "plan", fn: "Glance", marker: /\{g\.dispatched\} <small>авто<\/small>/ },
  { label: "на суму", where: "плитка «Авто й ціна»", file: "plan", fn: "Glance", marker: /<span>на суму<\/span><b>\{fmt\(g\.dispatchedRevenue\)\} ₴<\/b>/ },
  { label: "ціну названо в 1-й дотик", where: "плитка «Авто й ціна»", file: "plan", fn: "Glance", marker: /<span>ціну названо в 1-й дотик/ },
  // ── плитка дня ──
  { label: "авто й отримано за день", where: "плитка дня", file: "plan", fn: "Glance", marker: /\{fg\?\.dispatched \?\? 0\} <small>авто · \{k\(fg\?\.fact \?\? 0\)\} отримано<\/small>/ },
  { label: "створено угод за день", where: "плитка дня", file: "plan", fn: "Glance", marker: /створено <b>\{fg\?\.created \?\? 0\}<\/b> угод/ },
  // ── над списком ──
  { label: "Застряглі угоди", where: "над списком", file: "plan", marker: /<StuckBlock teamId=/ },
  { label: "зріз «усі / нові / постійні / невизначено»", where: "над списком", file: "plan", marker: /<SliceSwitch data=\{data\}/ },
  // ── картка менеджера (без кліку) ──
  { label: "рівень «Старт / Профі»", where: "картка", file: "plan", fn: "MgrStrip", marker: /<LevelChip level=\{m\.level\} \/>/ },
  { label: "стан менеджера словом", where: "картка", file: "plan", fn: "MgrStrip", marker: /\{SLBL\[s\]\.toLowerCase\(\)\}/ },
  { label: "🚚 чекають рішення (дзвінки на мобільні)", where: "картка", file: "plan", fn: "MgrStrip", marker: /🚚 чекають рішення: \{aw\.awaitingNow\}/ },
  { label: "тиждень: отримано з плану тижня", where: "картка", file: "plan", fn: "MgrStrip", marker: /Тиждень \{weekLabel\} · <b>\{fmt\(m\.week\.fact\)\}<\/b> з \{fmt\(m\.week\.target\)\}/ },
  { label: "Відправлено за тиждень", where: "картка", file: "plan", fn: "MgrStrip", marker: /Відправлено · <b>\{fmt\(sent\)\} ₴<\/b>/ },
  { label: "створено · нов · пост", where: "картка", file: "plan", fn: "MgrStrip", marker: /<b>\{m\.created\}<\/b>створено<small>\{m\.new\} нов · \{m\.rep\} пост<\/small>/ },
  { label: "авто і ₴ авто", where: "картка", file: "plan", fn: "MgrStrip", marker: /<b>\{dispCnt\}<\/b>авто<small>/ },
  { label: "сер. чек", where: "картка", file: "plan", fn: "MgrStrip", marker: /<b>\{chekFact == null \? "—" : fmt\(chekFact\)\}/ },
  { label: "отримано ₴", where: "картка", file: "plan", fn: "MgrStrip", marker: /<b>\{fmt\(m\.fact\)\}<\/b>отримано ₴/ },
  { label: "пропущені (без передзвону)", where: "картка", file: "plan", fn: "MgrStrip", marker: /<\/b>пропущені<\/div>/ },
  { label: "гістограма отриманого по тижнях", where: "картка", file: "plan", fn: "MgrStrip", marker: /className="rv-spark"/ },
  // ── розкриття картки ──
  { label: "тиждень · задача із Задачника", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<h4>Тиждень · задача із Задачника/ },
  { label: "📅 Показники за період (авто, авто за джерелом, сер. чек, ціну названо)", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<h4>📅 Показники <small>/ },
  { label: "авто за джерелом", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<span>авто за джерелом<\/span>/ },
  { label: "Гроші тижня", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<WeekMoney mWeek=\{mWeek\}/ },
  { label: "Дзвінки й реакція: пропущені, передзвін, розмов / спроб", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<span>розмов \/ спроб<\/span><b>\{m\.talks\} \/ \{m\.attempts\}<\/b>/ },
  { label: "розкриття по тижнях і днях", where: "розкриття картки", file: "plan", fn: "MgrStrip", marker: /<DayDrill managerId=\{m\.managerId\}/ },
];

/**
 * 📋 КОЛОНКИ ТАБЛИЦІ — КЛЮЧ І НАЗВА, усі 40 (стан 18.11.2026, з LinkedIn і Prozorro задачі 9230).
 * Звіряються з `REPORT_COLS` фронта в обидва боки: таблиця малює рівно реєстр (`#7724`).
 */
const TABLE_COLUMNS: [string, string][] = [
  ["rank", "#"], ["name", "Менеджер"], ["status", "Статус"],
  ["fact", "Отримано"], ["plan", "План"], ["pct", "Виконано"], ["projected", "Прогноз"], ["needPerDay", "Треба ₴/день"],
  ["avgCheck", "Сер. чек"], ["factNew", "Отримано · нові"], ["factRepeat", "Отримано · постійні"],
  ["factUndef", "Отримано · невизначено"], ["dobir", "Добір"],
  ["expectThisMonth", "Очікує (з датою)"], ["jam", "Затор ₴"], ["jamDeals", "Затор (рах.)"],
  ["expectNew", "Очікує · нові"], ["expectRepeat", "Очікує · постійні"], ["awaitNoDate", "Без дати"],
  ["missed", "Пропущені"], ["callbackMin", "Передзвін"], ["talks", "Дзвінки"], ["firstTouch", "Ціну названо"],
  ["normDays", "Днів з нормою"], ["responseTime", "Ліди >1год"],
  ["created", "Створено"], ["ads", "Прийнято реклами"], ["leadgen", "Прийнято лідоген"], ["conv", "Конв. Р+Л"],
  ["convAd", "Конв. реклама (за каналом)"], ["convLg", "Конв. лідоген (за каналом)"],
  ["dispatch", "Авто ф/ц"], ["dispRevenue", "Авто-сума"],
  ["srcAd", "зі створених: реклама"], ["srcLeadgen", "зі створених: лідоген"], ["srcElogist", "зі створених: eLogist"],
  ["srcLinkedin", "зі створених: LinkedIn"], ["srcProzorro", "зі створених: Prozorro"],
  ["srcOther", "зі створених: без джерела"], ["srcNoChannel", "зі створених: канал не вказано"],
];

interface Removed { label: string; file: FileKey; marker: RegExp; since: string; decidedBy: string; whereNow: string }

/**
 * 🗑 ПРИБРАНО СВІДОМО — з автором, датою і «де це тепер». Сюди переносять показник, коли його
 * прибирають; без запису тут зникнення червоніє в `#7893`.
 */
const REMOVED_INDICATORS: Removed[] = [
  { label: "підзаголовок «Грошовий план — вкладка «Плани» (2.7 млн) · KPI-активність — задачник»", file: "plan",
    marker: /Грошовий план — вкладка «Плани» \(2\.7 млн\) · KPI-активність/, since: "2026-11-13",
    decidedBy: "Роман 13.11.2026, макет-ремейк Звіту («ні роби як макет угзодили»)", whereNow: "план — у плитці «Команда» (з … ₴)" },
  { label: "чип «Ти бачиш: <роль>»", file: "plan", marker: /Ти бачиш: </, since: "2026-11-13",
    decidedBy: "Роман 13.11.2026, макет-ремейк Звіту", whereNow: "ніде; скоуп задає роль" },
  { label: "смуга днів тижня (Пн–Нд) для вибору дня", file: "plan", marker: /weekOfFocus\.map\(/, since: "2026-11-13",
    decidedBy: "Роман 13.11.2026, макет-ремейк Звіту", whereNow: "режим «День» у виборі періоду + плитка дня" },
  { label: "«Обсяг»: кілька команд разом, один менеджер повною карткою, підсумок кожної команди в таблиці", file: "table",
    marker: /Обсяг:/, since: "2026-11-13",
    decidedBy: "Роман 13.11.2026, макет-ремейк Звіту; повернення — відкрите питання до Романа 18.11.2026 (пункт 1 TOP Weekly 16.11)",
    whereNow: "один вибір команди в шапці (`#7722`)" },
];

/** Транспілює чистий реєстр колонок і повертає його справжні експорти. */
async function loadCols(): Promise<any> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(path.join(FE, "reportTableCols.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "rptind-"));
  const file = path.join(dir, "cols.mjs");
  writeFileSync(file, js);
  return import(file);
}

/**
 * #7893 — КОЖЕН ПОКАЗНИК ЗВІТУ НА МІСЦІ; КОЛОНКИ ТАБЛИЦІ = РЕЄСТР В ОБИДВА БОКИ.
 * 🧨 Червоніє, якщо прибрати з екрана будь-що з `REPORT_INDICATORS` (плитку, рядок плитки, блок,
 * число картки), прибрати чи перейменувати колонку таблиці — або додати колонку, не вписавши її сюди.
 */
test("#7893 РЕЄСТР ПОКАЗНИКІВ ЗВІТУ: кожен показник на екрані, колонки таблиці = реєстр в обидва боки", async () => {
  assert.ok(REPORT_INDICATORS.length >= 30, `🔴 у реєстрі ${REPORT_INDICATORS.length} показників — розбір зламався`);
  const lost: string[] = [];
  for (const i of REPORT_INDICATORS) {
    const body = i.fn ? fnBody(i.file, i.fn) : src(i.file);
    if (i.fn) assert.ok(body.length > 0, `🔴 компонента ${i.fn} більше немає — показники «${i.where}» нема де шукати`);
    if (!i.marker.test(body)) lost.push(`${i.where}: ${i.label}`);
  }
  assert.deepEqual(lost, [], "🔴 зі Звіту зникло (якщо свідомо — перенеси в REMOVED_INDICATORS з автором і датою): " + lost.join("; "));

  const { REPORT_COLS } = await loadCols();
  const have = new Map<string, string>(REPORT_COLS.map((c: any) => [c.key, c.title]));
  const want = new Map<string, string>(TABLE_COLUMNS);
  const gone = [...want.keys()].filter((k) => !have.has(k));
  assert.deepEqual(gone, [], "🔴 з таблиці зникли колонки: " + gone.join(", "));
  const renamed = [...want].filter(([k, t]) => have.has(k) && have.get(k) !== t).map(([k, t]) => `${k}: «${t}» → «${have.get(k)}»`);
  assert.deepEqual(renamed, [], "🔴 колонку перейменовано (людина її не знайде за старою назвою): " + renamed.join("; "));
  const unlisted = [...have.keys()].filter((k) => !want.has(k));
  assert.deepEqual(unlisted, [], "🔴 нова колонка не вписана в реєстр показників: " + unlisted.join(", "));
});

/**
 * #7893b — ПРИБРАНЕ СВІДОМО: З АВТОРОМ, ДАТОЮ, «ДЕ ТЕПЕР» — І СПРАВДІ ПРИБРАНЕ.
 * 🧨 Червоніє, якщо запис без автора чи «де тепер», якщо «прибраний» показник досі в джерелі
 * (реєстр бреше), або якщо той самий показник одночасно «є» і «прибраний».
 */
test("#7893b РЕЄСТР ПРИБРАНОГО: з автором і датою, і справді прибране — реєстр не ковдра", () => {
  assert.ok(REMOVED_INDICATORS.length > 0, "🔴 реєстр прибраного порожній — розбір зламався");
  for (const r of REMOVED_INDICATORS) {
    assert.match(r.since, /^\d{4}-\d{2}-\d{2}$/, `🔴 «${r.label}»: дата зняття не дата`);
    assert.ok(r.decidedBy.trim().length > 5, `🔴 «${r.label}»: прибрано без автора — зняття неможливо оскаржити`);
    assert.ok(r.whereNow.trim().length > 2, `🔴 «${r.label}»: не сказано, де це тепер`);
    assert.equal(r.marker.test(src(r.file)), false, `🔴 «${r.label}» записано прибраним, а воно досі в джерелі — реєстр бреше`);
  }
  const both = REMOVED_INDICATORS.filter((r) => REPORT_INDICATORS.some((i) => i.label === r.label)).map((r) => r.label);
  assert.deepEqual(both, [], "🔴 показник одночасно «є» і «прибраний»: " + both.join("; "));
});
