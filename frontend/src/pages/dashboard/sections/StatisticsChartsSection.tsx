import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, ReferenceDot, Brush,
} from "recharts";
import { effGranOf } from "../statsGran";
import { MAX_METRICS, canAdd, drawnScopes, multiLines, multiRows } from "../statsMulti";
import {
  cardFigures, cardDelta, asOfLabel, makeCardMemo, parseMine, periodStartOf, MINE_KEY, MINE_MAX, type Better, type CardGran,
  parseWallView, stackPeriods, effStackPeriod, wallFrom, stackWindow, WALL_VIEW_KEY, type WallView, type StackPeriod,
} from "../statsCards";
import { fetchStatsSeries, saveStatsManual, fetchLapsedClients, type StatsSeriesResp, type StatsSeries, type LapsedClientsResp } from "../../../api";
import { InfoHint } from "../widgets";
import { ChartSkeleton, SkelBox, TableSkeleton } from "../Skeleton";
import { StatsMiniChart } from "./StatsMiniChart";
import { StatsStackChart, STACK_CHART_HEIGHT } from "./StatsStackChart";
import { splitCurrent, teamKeys, periodTick, periodTitle, fmt, FULL_SUFFIX, CUR_SUFFIX } from "../statsChart";

/* 🎨 Категорійна палітра (фіксований порядок; компанія завжди [0]). Перевірена валідатором dataviz 23.11.2026 на білій
   картці (#ffffff) і темній (#1a1d27): сусіди розрізнювані і зі звичайним зором (ΔE ≥ 15), і для дальтоніків
   (ΔE ≥ 8), контраст до фону ≥ 3:1 в обох темах. Зеленого й червоного в ній немає навмисно: ними картки кажуть
   «краще / гірше», і команда не мусить виглядати «поганою» через свій колір. Було: салатовий і зелений злипались
   (ΔE 5,7), фіолетовий у темній темі мав 2,95:1. Тримає `#10903`. */
export const COLORS = ["#2f6fdb", "#ea580c", "#0891b2", "#db2777", "#c026d3", "#a16207", "#8b5cf6", "#059669"];
const MUTED = "var(--text-muted)";

/** `companyOnly` — показник рахується лише по компанії (по командах його не розрізає джерело): картка тімліда й менеджера
 *  каже це словами, а не показує порожнечу. `src` — звідки число, підписом на картці. */
type Metric = { key: string; block: string; label: string; unit?: string; better?: Better; monthOnly?: boolean; weekOnly?: boolean; manual?: boolean; hint?: string; seamHint?: string; unitScope?: string; companyOnly?: boolean; src?: string };
type Cat = { key: string; icon: string; label: string; metrics: Metric[]; manualForm?: boolean };

const CALLS_HINT = "Результативні дзвінки Ringostat (billsec>0); у дашборді вони є з 09.2025 — раніше ряду немає.";
/* ⏱ «Час опрацювання заявки» — той самий розрахунок, що вікно в Звіті (ядро `core/leadTake.ts`). */
const LEAD_TAKE_HINT = "те саме ядро, що вікно «Час опрацювання заявки» у Звіті: «взято в роботу» — перша з подій (зміна етапу, вихідний дзвінок, поле «Взято в работу»); заявки з реклами, сайту й лідгенів, ЛИШЕ в робочий час (пн–пт 8:00–18:00; у вікні Звіту — фільтр «Час: Робочий»); дата — створення заявки за Києвом · до вересня поле «Взято в роботу» й нотатки-дзвінки майже порожні — частка «взято» тоді спиралась на етап і Ringostat";
const LEAD_TAKE_MEDIAN_HINT = `медіана хвилин від створення заявки до «взято в роботу» серед узятих — окремо за кожну точку (медіана точки — з угод, не середнє); ${LEAD_TAKE_HINT}`;
const LEAD_TAKE_SHARE_HINT = `частка заявок, узятих у роботу не пізніше 5 хв («до 1 хв» включно), від усіх заявок точки; ${LEAD_TAKE_HINT}`;
const AD_HINT = "ті самі гроші, що плитка «Надійшло» на екрані «Реклама» (ядро `money.adReceivedByDay`): оплата отримана ∪ успішно реалізовано угод рекламних клієнтів (правило Сергія: клієнт прийшов з реклами — далі всі його угоди реклама), за датою надходження; лише компанія";
const LG_HINT = "гроші й машини з екрана «Лідогенерація» (правило Ярослава, словник §13): угоди менеджерів із передач лідгена будь-якої давності; лише компанія і лише помісячно, як тренд того екрана";
const FIN_HINT = "рядок екрана «Фінанси → Тиждень і місяць» тим самим ядром (`core/financeKpiRefs.ts`); бачать ті, кому відкрито «Фінанси»";
const HR_HINT = "реєстр людей, та сама формула, що «Плинність» на екрані «Люди» (`core/churn.ts`): працювали в місяці = прийняті до його кінця і не звільнені до його початку; бачать ті, кому відкрито реєстр людей";

/**
 * 🧱 ВІДДІЛИ СТІНИ (погоджений макет 20.11.2026, Продажі · Реклама · Лідогенерація · Тендери і LinkedIn · Логістика ·
 * Фінанси · HR). Кожен ряд — з CRM або з розділу дашборда (Роман 20.11: «всі дані з CRM і дашборду, інших немає»);
 * ручна таблиця з екрана прибрана. Показники, які жили лише в таблиці (готівкові, напрямки, тендерні заявки / авто /
 * комісія, Cash flow, «Дохід (акт)»), зняті, а не лишені порожніми.
 */
const CATS: Cat[] = [
  { key: "sales", icon: "💰", label: "Продажі", metrics: [
    { key: "payment_received", block: "sales", label: "Отримані кошти", unit: "₴", hint: "оплата отримана ∪ успішно реалізовано, без подвоєння — ті самі гроші, що «Отримані кошти» на Звіті" },
    { key: "revenue_success", block: "sales", label: "Дохід (успіх)", unit: "₴", hint: "успішні угоди (142) за датою закриття, signed" },
    /* 4367 (ТЗ Юлі): з підказки мусить бути видно, ЗА ЯКИЙ ПЕРІОД і ЗА ЯКОЮ ДАТОЮ угоди. Анкер — дата переходу угоди
       в «Успішно реалізовано» (142) за Києвом, не дата оплати й не відвантаження. */
    { key: "avg_check", block: "sales", label: "Середній чек", unit: "₴", hint: "виручка «успішно реалізовано» ÷ кількість таких угод — окремо за кожну точку (день, тиждень чи місяць — за «Кроком»); дата угоди — день переходу в «Успішно реалізовано», за Києвом (не дата оплати й не відвантаження)" },
    { key: "cars_success", block: "sales", label: "Успішні", hint: "кількість угод, що перейшли в «Успішно реалізовано», за датою переходу (Київ), кожна раз" },
    { key: "cars_delivered", block: "sales", label: "Поставлені", hint: "авто за датою завантаження — те саме, що «Відправлені авто» на Звіті; company включає поставки поза 6 командами (~0.5%)" },
    { key: "calls", block: "sales", label: "Результативні дзвінки", hint: CALLS_HINT, src: "Ringostat" },
    /* Медіана, не середнє (рішення власника 26.10.2026): медіана кошика — з угод, а не медіана медіан. Лінії цілі немає (5708). */
    { key: "lead_take_median", block: "sales", label: "Медіана часу опрацювання заявки, хв", unit: "хв", better: "down", hint: LEAD_TAKE_MEDIAN_HINT },
    { key: "lead_take_m5_pct", block: "sales", label: "Взято до 5 хв, %", unit: "%", hint: LEAD_TAKE_SHARE_HINT },
  ] },
  { key: "ads", icon: "📣", label: "Реклама", metrics: [
    { key: "ad_leads", block: "marketing", label: "Ліди з реклами", hint: "угоди з каналом «реклама», за першим входом у «Взято в роботу» в межах періоду — кожна угода раз" },
    { key: "ad_received_sum", block: "marketing", label: "Надійшло з реклами", unit: "₴", companyOnly: true, hint: AD_HINT },
    { key: "ad_received_deals", block: "marketing", label: "Оплачені угоди з реклами", companyOnly: true, hint: "кількість угод у сумі «Надійшло з реклами»; " + AD_HINT },
    { key: "ad_received_avg", block: "marketing", label: "Чек оплачених з реклами", unit: "₴", companyOnly: true, hint: "надійшло з реклами ÷ ці угоди — окремо за кожну точку; " + AD_HINT },
  ] },
  { key: "leadgen", icon: "🎯", label: "Лідогенерація", metrics: [
    { key: "lg_transfers", block: "marketing", label: "Прорахунки лідгенів", companyOnly: true, hint: "входи угод у «Кваліфіковано» — як на екрані «Лідогенерація»; лише компанія, по командах не розрізається" },
    { key: "lg_earned_sum", block: "marketing", label: "Успішні з лідгену", unit: "₴", monthOnly: true, companyOnly: true, hint: "«Успішні»: угоди, що стали «Успішна угода» в цьому місяці; " + LG_HINT },
    { key: "lg_earned_deals", block: "marketing", label: "Угоди «Успішні» з лідгену", monthOnly: true, companyOnly: true, hint: "кількість угод у сумі «Успішні з лідгену»; " + LG_HINT },
    { key: "lg_machines", block: "marketing", label: "Машини з лідгену", monthOnly: true, companyOnly: true, hint: "«Машин» за «Датою загрузки» в місяці, як «Відправлені авто» КВП; " + LG_HINT },
  ] },
  { key: "tenders", icon: "🏛", label: "Тендери і LinkedIn", metrics: [
    { key: "prozorro_deals", block: "sales", label: "Угоди Prozorro (створено)", hint: "угоди Повного циклу, створені в періоді, з міткою Prozorro (словник §21) — та сама колонка «зі створених: Prozorro», що у Звіті (`metrics.createdSplitByBucket`)" },
    { key: "linkedin_deals", block: "sales", label: "Угоди LinkedIn (створено)", hint: "угоди Повного циклу, створені в періоді, з міткою LinkedIn (словник §20) — та сама колонка «зі створених: LinkedIn», що у Звіті (`metrics.createdSplitByBucket`)" },
  ] },
  { key: "logistics", icon: "🚚", label: "Логістика", metrics: [
    { key: "cars_delivered_all", block: "logistics", label: "Відправлені авто всього", hint: "авто за датою завантаження — те саме число, що «Поставлені» в Продажах і «Відправлені авто» на Звіті" },
    { key: "new_clients_cars", block: "logistics", label: "Машини нових клієнтів", hint: "відправлені авто всього мінус машини постійних (словник §22): клієнт без жодної попередньої виграної угоди, джерело не важливе — реклама, лідоген і решта теж нові" },
    { key: "repeat_clients_active", block: "logistics", label: "Постійні в роботі", hint: "постійний = has_prior (≥1 попередня виграна)" },
    { key: "repeat_clients_cars", block: "logistics", label: "Машини постійних", hint: "відправлені авто клієнтів, у яких уже була виграна угода, — за датою завантаження" },
    { key: "repeat_clients_sum", block: "logistics", label: "Сума постійних", unit: "₴", hint: "сума угод (ціна) тих самих авто постійних клієнтів, за датою завантаження" },
    { key: "repeat_avg_check", block: "logistics", label: "Чек постійних", unit: "₴", hint: "сума постійних ÷ машини постійних — окремо за кожну точку" },
  ] },
  { key: "finance", icon: "💵", label: "Фінанси", metrics: [
    { key: "fin_bank_in", block: "finance", label: "Надходження", unit: "₴", companyOnly: true, src: "Фінанси", hint: "«Надходження» — банк, словник §18; банк у дашборді з 10.2026; " + FIN_HINT },
    { key: "fin_bank_out", block: "finance", label: "Витрати загальні", unit: "₴", better: "neutral", companyOnly: true, src: "Фінанси", hint: "«Витрати загальні» — банк, словник §18; банк у дашборді з 10.2026; " + FIN_HINT },
    { key: "fin_receivables", block: "finance", label: "Дебіторка", unit: "₴", better: "neutral", companyOnly: true, src: "Фінанси", hint: "«Дебіторка»: на кінець періоду з журналу, для періоду, що йде, — станом на зараз; ряд з 10.2026; " + FIN_HINT },
    { key: "fin_delivered_income", block: "finance", label: "Дохід поставлених", unit: "₴", companyOnly: true, src: "Фінанси", hint: "«Дохід поставлених» за фільтрами фінансиста (`core/money.ts`); ряд з 09.2026; " + FIN_HINT },
  ] },
  { key: "hr", icon: "🧑‍💼", label: "HR", metrics: [
    { key: "hr_headcount", block: "hr", label: "Штат", monthOnly: true, companyOnly: true, src: "реєстр людей", hint: "скільки людей працювали в місяці; " + HR_HINT },
    { key: "hr_hired", block: "hr", label: "Прийнято", monthOnly: true, companyOnly: true, src: "реєстр людей", hint: "прийняті в місяці за датою прийому; " + HR_HINT },
    { key: "hr_fired", block: "hr", label: "Звільнено", better: "down", monthOnly: true, companyOnly: true, src: "реєстр людей", hint: "звільнені в місяці за датою звільнення (з невідомою датою — поза розрахунком); " + HR_HINT },
    { key: "hr_turnover_total", block: "hr", label: "Плинність", unit: "%", better: "down", monthOnly: true, companyOnly: true, src: "реєстр людей", hint: "звільнено ÷ працювали в місяці × 100 — уже у відсотках (20 = 20%), а не частка; " + HR_HINT },
  ] },
  /* 📣 Окремий розділ меню «Реклама» (ТЗ 28.09, блок 4, п.6) — див. `AdsPage.tsx`; тут лише його числа картками. */
  { key: "manual", icon: "✍️", label: "Ручні", manualForm: true, metrics: [
    { key: "budget_yalogist", block: "marketing", label: "Бюджет Ялогист", unit: "₴", manual: true },
    { key: "budget_uts", block: "marketing", label: "Бюджет ЮТС", unit: "₴", manual: true },
    { key: "budget_evrazia", block: "marketing", label: "Бюджет Эвразия", unit: "₴", manual: true },
    { key: "lg_budget", block: "marketing", label: "Бюджет лідгену", unit: "₴", manual: true },
    { key: "lg_headcount", block: "marketing", label: "Штат лідгену", manual: true },
    { key: "tender_requests", block: "tenders", label: "Тендер: заявки", manual: true },
    { key: "tender_cars", block: "tenders", label: "Тендер: авто", manual: true },
  ] },
];

/** 📈 Показники, які можна додати на графік з БУДЬ-ЯКОГО відділу (зустріч 20.11, Саша: «щоб накладались графіки»). */
const MULTI_POOL: { cat: Cat; m: Metric }[] = CATS.filter((c) => !c.manualForm)
  .flatMap((c) => c.metrics.filter((m) => !m.unitScope).map((m) => ({ cat: c, m })));
/** Усі показники стіни — для «★ Мій набір» і для розгортання показника з будь-якого відділу. Ключ унікальний. */
const WALL_POOL: Metric[] = MULTI_POOL.map((x) => x.m);
const MULTI_NOTE = "Збіг ліній не доводить, що один показник впливає на інший.";

// 📤 Експортуються для графіка «Пропущених дзвінків» (17.09.2026): той самий вигляд діапазонів і вікна,
// а не друга копія логіки, що розійдеться з цією на першій правці.
export const shortDate = (p: string) => { const [y, m, d] = p.split("-"); return `${d}.${m}.${y.slice(2)}`; };
export const RANGES: Record<string, number> = { "3м": 90, "6м": 180, "12м": 365, "Усе": 9999 };
export const MIN_WIN = 3; // мінімальна ширина вікна брашу (≥4 точки) — щоб не з'їжджало в 2-точкову пряму
// Вікно [lo,hi] (індекси у ПОВНОМУ rows) для діапазону 3м/6м/12м/Усе.
export function rangeWindow(rows: { period: string }[], range: string): { lo: number; hi: number } {
  const hi = rows.length - 1;
  if (hi < 0) return { lo: 0, hi: 0 };
  if (range === "Усе") return { lo: 0, hi };
  const cut = new Date(rows[hi].period); cut.setDate(cut.getDate() - RANGES[range]);
  const cs = cut.toISOString().slice(0, 10);
  let lo = rows.findIndex((r) => r.period >= cs); if (lo < 0) lo = 0;
  if (hi - lo < MIN_WIN) lo = Math.max(0, hi - MIN_WIN);
  return { lo, hi };
}

/** 📏 Круглі поділки осі Y (ТЗ, блок 4, п.4): 0 / 5к / 10к / 15к, а не 0к · 4к · 7к · 11к · 14к. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const axisFmt = (v: number, unit?: string) => {
  if (unit === "%") return `${v}%`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString("uk-UA", { maximumFractionDigits: 1 })} млн`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}к`;
  return String(v);
};
/* 🗓 ГЛИБИНА РЯДУ (було «шов 01.07», доки історія йшла з ручної таблиці). Імʼя константи лишилось, зміст — новий: таблиці
   на екрані більше немає, ряд — лише CRM і розділи дашборда, і він починається там, де CRM має повну історію.
   Заміряно 20.11.2026 на проді (місяць за місяцем проти ручного підрахунку): з 06.2025 гроші й угоди сходяться в межах
   0–10% (це відомий розрив мінусових угод), раніше CRM має лише 12–48% угод. Межа — `STATS_CRM_FROM` на сервері. */
const SEAM_NOTE = "Ряд — лише з CRM і розділів дашборда, від 06.2025: раніше CRM має лише частину угод (12–48% від ручного підрахунку), тож довший ряд показав би «зростання», якого не було. Команди до 14.07.2026 — за поточним складом (Kommo не зберігає історії переходів).";
/** ⓘ біля перемикача карток: як читати картку. */
const WALL_NOTE = "Картка — останній ПОВНИЙ місяць (тиждень) і зміна до попереднього повного. Період, що йде, — окремим рядком «станом на» і в порівняння не потрапляє: половина місяця проти цілого читалась би як обвал. Малий графік картки — лише повні періоди; на розгорнутому період, що йде, — пунктиром із порожньою точкою в сірій смузі «іде». Без позначки джерела — число з CRM. " + SEAM_NOTE;

/** ⓘ у вигляді «Один під одним»: як читати стовпчик. */
const STACK_NOTE = "Один показник — один графік зі своєю шкалою; вісь часу в усіх спільна, тож місяці стоять один під одним. Наведення показує той самий період на всіх графіках. Ліворуч — ті самі цифри, що на картці: останній ПОВНИЙ місяць (тиждень) і зміна до попереднього повного. Період, що йде, — пунктиром із порожньою точкою в сірій смузі «іде». Лінії команд — у «Розгорнути». Без позначки джерела — число з CRM. " + SEAM_NOTE;

/** Сьогодні за Києвом — межа «повний період / період, що йде» на картках і на графіку. */
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const dm = (p: string) => `${p.slice(8, 10)}.${p.slice(5, 7)}`;
const addDays = (p: string, n: number) => { const d = new Date(`${p}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Підпис періоду картки: місяць — «жовтень 2026», тиждень — «09.11–15.11». */
const periodLabel = (p: string, g: CardGran) => (g === "month" ? `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}` : `${dm(p)}–${dm(addDays(p, 6))}`);
const prevLabel = (p: string, g: CardGran) => (g === "month" ? `до ${MONTHS_GEN[Number(p.slice(5, 7)) - 1]}` : `до тижня ${dm(p)}`);
const errText = (e: any) => e?.response?.data?.error ?? (e?.response?.status ? `сервер відповів ${e.response.status}` : "немає звʼязку з сервером");
/** Звідки число — підпис на картці. */
const srcOf = (m: Metric) => m.src ?? "CRM";

/**
 * 📊 «СТАТИСТИКИ» — СТІНА ГРАФІКІВ ПО ВІДДІЛАХ (погоджений макет, зустріч 20.11.2026: Саша «як у Looker — багато
 * графіків, натискаєш, вони розкриваються»; Роман 20.11: картки з цифрами — так, ТЗ 14.10 «лише графіки» скасовано).
 *
 * Ліворуч відділи (і «★ Мій набір»), праворуч усі показники відділу картками: останній повний період, зміна до
 * попереднього повного, період, що йде, «станом на» (`statsCards.cardFigures`). Клік по картці розгортає показник —
 * той самий графік, що був (команди, браш, «＋ Показник» уже з будь-якого відділу) і таблиця значень.
 * Картки тягнуть легкий запит (`scope=main`: лише головна серія глядача), команди — лише в розгорнутому показнику.
 * План на графіку й надалі не малюється (ТЗ 14.10). `StatisticsSummary` / `StatisticsPlanFact` лишаються без входу.
 */
export default function StatisticsChartsSection({ role }: { role?: string }) {
  const [catKey, setCatKey] = useState("sales");
  /* ★ «Мій набір» — у браузері (Роман 20.11). Сміття в ключі не кладе екран: `parseMine` лишає лише відомі ключі. */
  const [mine, setMine] = useState<string[]>(() => {
    try { return parseMine(localStorage.getItem(MINE_KEY), WALL_POOL.map((m) => m.key)); } catch { return []; }
  });
  const saveMine = (ks: string[]) => { setMine(ks); try { localStorage.setItem(MINE_KEY, JSON.stringify(ks)); } catch { /* приватний режим — набір живе до перезавантаження */ } };
  const mineMetrics: Metric[] = mine.flatMap((k) => WALL_POOL.filter((m) => m.key === k).slice(0, 1));
  const cat: Cat = catKey === "mine" ? { key: "mine", icon: "★", label: "Мій набір", metrics: mineMetrics } : (CATS.find((c) => c.key === catKey) ?? CATS[0]);
  /* 🎯 null — стіна відділу; ключ — розгорнутий показник (з будь-якого відділу, тож шукаємо і в усьому пулі). */
  const [metricKey, setMetricKey] = useState<string | null>(null);
  /* 📣 Метрики може НЕ бути (стіна, порожній «Мій набір») — тип пишемо ЯВНО: без `noUncheckedIndexedAccess` вираз
     `cat.metrics[0]` типізується як `Metric`, тож компілятор мовчить, а падає рантайм.
     Саме так 08.09.2026 клік по «Рекламі» клав увесь екран Статистик на `metric.monthOnly`. */
  const metric: Metric | undefined = metricKey == null ? undefined : (cat.metrics.find((m) => m.key === metricKey) ?? WALL_POOL.find((m) => m.key === metricKey));
  const today = kyivToday();
  const [cardGran, setCardGran] = useState<CardGran>("month");
  /* ☰ Вигляд стіни: «Картки» або «Один під одним» (Роман 24.11.2026). Вибір — у браузері, типовий — «Картки»; сміття в
     ключі екран не кладе (`parseWallView`). Період стовпчика живе тут, щоб «Розгорнути» і повернення його не скидали. */
  const [wallView, setWallView] = useState<WallView>(() => {
    try { return parseWallView(localStorage.getItem(WALL_VIEW_KEY)); } catch { return parseWallView(null); }
  });
  const saveWallView = (v: WallView) => { setWallView(v); try { localStorage.setItem(WALL_VIEW_KEY, v); } catch { /* приватний режим — вибір живе до перезавантаження */ } };
  const [stackPeriod, setStackPeriod] = useState<StackPeriod>("12");
  const [gran, setGran] = useState<"day" | "week" | "month">("week");
  /* 🗓 Дефолт — 3 місяці (ТЗ, блок 4, п.1); було 12 місяців і 7 ліній. */
  const [range, setRange] = useState("3м");
  const [resp, setResp] = useState<StatsSeriesResp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /* ⏳ Графік вантажиться — на його місці заготовка ТІЄЇ САМОЇ висоти, легенда лишається (прохання Романа 02.10). */
  const [chartLoading, setChartLoading] = useState(true);
  /* ⚡ Перша лінія вже на графіку, решта розрізів (команди, менеджери) ще їде — легенда каже це словами. */
  const [scopesLoading, setScopesLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** Які серії ПОКАЗАНІ. Дефолт — лише компанія; команди додаються вибором (ТЗ, блок 4, п.1). */
  const [shown, setShown] = useState<Set<string> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [win, setWin] = useState<{ lo: number; hi: number; key: string } | null>(null);
  const [drag, setDrag] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });

  /* 📈 ДОДАНІ ПОКАЗНИКИ (5707 п.2): до двох поверх основного, разом не більше 3 і не більше 2 одиниць (`statsMulti.ts`).
     Зміна основного показника їх скидає — інакше на графіку лишились би лінії, яких людина вже не обирала. */
  const [extraKeys, setExtraKeys] = useState<string[]>([]);
  const [extraResp, setExtraResp] = useState<Record<string, StatsSeriesResp>>({});
  const [extraErr, setExtraErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { setExtraKeys([]); setPickerOpen(false); }, [metric?.key, metric?.unitScope]);
  const extras: Metric[] = extraKeys.flatMap((k) => MULTI_POOL.filter((x) => x.m.key === k).slice(0, 1).map((x) => x.m));
  const chosen: Metric[] = metric ? [metric, ...extras] : [];
  const multi = extras.length > 0;

  const effGran = effGranOf(metric, gran); // показник лише помісячно (HR, гроші лідгену) → місяць
  /** Початок періоду, що йде: на графіку — пунктир і підпис «іде, станом на» у підказці. */
  const curStart = effGran === "day" ? today : periodStartOf(today, effGran);
  useEffect(() => {
    let alive = true; setChartLoading(true); setLoadErr(null); setWin(null); setScopesLoading(false);
    if (!metric) return; // категорія без метрик серій не тягне
    const m = metric;    // звужений локальний — далі жодного дотику до можливо-порожнього `metric`
    const q = { block: m.block, metric: m.key, granularity: effGran, ...(m.unitScope ? { unit: m.unitScope } : {}) };
    /* ⚡ ДВА ЗАПИТИ (21.11.2026): перша лінія (`scope=first` — та, що малюється за замовчуванням) приходить одразу з
       памʼяті сервера, і графік видно; усі розрізи — слідом, і підміняють відповідь. Раніше одна лінія чекала сім
       розрізів (час опрацювання — 12 с). Повна відповідь прийшла першою — рання вже не потрібна (`full`). */
    let full = false;
    fetchStatsSeries({ ...q, scope: "first" })
      .then((d) => { if (alive && !full) { setResp(d); setChartLoading(false); setScopesLoading(true); } })
      .catch(() => undefined); // помилку назве повний запит — два повідомлення про одне були б шумом
    fetchStatsSeries(q)
      .then((d) => { full = true; if (alive) { setResp(d); setChartLoading(false); setScopesLoading(false); } })
      /* 🔴 ПОМИЛКА — ЯВНО, а не «Немає даних (очікує вводу)» і не вічне «Завантаження…» (ТЗ, блок 1, п.2):
         обидва варіанти брехали про причину. */
      .catch((e) => { full = true; if (alive) { setChartLoading(false); setScopesLoading(false); setLoadErr(e?.response?.data?.error ?? (e?.response?.status ? `сервер відповів ${e.response.status}` : "немає звʼязку з сервером")); } });
    return () => { alive = false; };
  }, [metric?.block, metric?.key, effGran, metric?.unitScope, nonce]);

  // Додані показники — паралельними викликами тієї самої `/api/statistics/series` (нового бекенду немає).
  useEffect(() => {
    let alive = true; setExtraErr(null);
    if (!extras.length) { setExtraResp({}); return; }
    Promise.all(extras.map((m) => fetchStatsSeries({ block: m.block, metric: m.key, granularity: effGran }).then((d) => [m.key, d] as const)))
      .then((pairs) => { if (alive) setExtraResp(Object.fromEntries(pairs)); })
      .catch((e) => alive && setExtraErr(e?.response?.data?.error ?? (e?.response?.status ? `сервер відповів ${e.response.status}` : "немає звʼязку з сервером")));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraKeys.join("|"), effGran, nonce]);

  // Скоуп за замовчуванням: компанія (або перша серія, якщо компанії в скоупі немає).
  const visibleKeys = useMemo(() => {
    if (!resp) return new Set<string>();
    if (shown) return shown;
    const first = resp.series.find((s) => s.scopeType === "company") ?? resp.series[0];
    return new Set<string>(first ? [first.scopeKey] : []);
  }, [resp, shown]);

  // усі періоди (вісь X) + рядки для recharts. Плану на графіку немає (ТЗ 14.10, п.1) — сервер його й далі віддає, екран не малює.
  const { rows: singleRows, seriesList } = useMemo(() => {
    if (!resp) return { rows: [] as any[], seriesList: [] as StatsSeries[] };
    const periods = new Set<string>();
    resp.series.forEach((s) => s.points.forEach((p) => periods.add(p.period)));
    const sorted = [...periods].sort();
    const map = new Map(sorted.map((p) => [p, { period: p } as any]));
    resp.series.forEach((s, i) => s.points.forEach((p) => { map.get(p.period)![`s${i}`] = p.value; }));
    return { rows: sorted.map((p) => map.get(p)!), seriesList: resp.series };
  }, [resp]);

  const legendKeys = seriesList.filter((s) => showArchived || !s.archived).map((s) => s.scopeKey);
  /* 🎯 Кілька показників — ОДИН скоуп (компанія АБО одна команда): інакше 3 × 7 = 21 лінія. Клік по скоупу тоді лише перемикає. */
  const multiScope = multi ? (drawnScopes(chosen.length, legendKeys, visibleKeys)[0] ?? null) : null;
  const lines = multiLines(chosen);
  const mRows = useMemo(() => (multi ? multiRows(chosen.map((m, j) => (j === 0 ? resp : extraResp[m.key])), multiScope) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [multi, resp, extraResp, multiScope, extraKeys.join("|")]);
  const baseRows: any[] = multi ? mRows : singleRows;
  /* ⏳ Період, що йде, — окремою пунктирною лінією від останнього повного (`splitCurrent`, тримає `#10902`): суцільна
     лінія, що падала в неповний місяць, читалась як обвал. Вихідні ключі (`s{i}` / `m{j}`) лишаються — їх читають
     таблиця, поділки осі й аномалії. */
  const drawKeys = multi ? lines.map((l) => l.dataKey) : seriesList.map((_, i) => `s${i}`);
  const drawKeysSig = drawKeys.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows: any[] = useMemo(() => splitCurrent(baseRows, drawKeys, curStart), [baseRows, drawKeysSig, curStart]);
  /* 🔑 НОВІ ДАНІ — НОВИЙ ГРАФІК (огляд 23.11.2026, видно на проді: «12 міс» натиснуто, а графік від 06.2025).
     recharts 3 на зміні `data` скидає вікно брашу на весь ряд, а `startIndex`/`endIndex` повторно не застосовує, бо
     ці пропси не змінились. Тож щойно після першої лінії довантажувались команди, вікно розʼїжджалось із кнопкою.
     Перемонтування на кожні нові рядки повторює перший показ, де вікно стає рівно `eff`. Тримає `#10900`. */
  const chartVerRef = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chartVer = useMemo(() => ++chartVerRef.current, [rows]);

  const winKey = `${range}:${rows.length}`;
  const eff = useMemo(() => {
    if (!rows.length) return { lo: 0, hi: 0 };
    if (win && win.key === winKey) {
      let lo = Math.max(0, Math.min(win.lo, rows.length - 1));
      let hi = Math.max(0, Math.min(win.hi, rows.length - 1));
      if (hi < lo) { const t = lo; lo = hi; hi = t; }
      return { lo, hi };
    }
    return rangeWindow(rows, range);
  }, [rows, range, win, winKey]);

  const color = (i: number) => COLORS[i % COLORS.length];
  const visibleSeries = seriesList.map((s, i) => ({ s, i })).filter(({ s }) => visibleKeys.has(s.scopeKey) && (showArchived || !s.archived));
  const toggle = (k: string) => setShown(() => { const n = new Set(visibleKeys); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const isolate = (k: string) => setShown(new Set([k]));
  const isDrawn = (k: string) => (multi ? k === multiScope : visibleKeys.has(k));
  /** 👥 «Усі команди» одним кліком (Роман 16.10.2026: «щоб не клікати по одній») — усі КОМАНДИ легенди, без лінії
   *  компанії (огляд 23.11.2026: компанія ~3 млн на одній осі з командами 0,1–1 млн притискала їх до нуля); розформовані —
   *  лише з «показати архівні». Компанію можна повернути кліком у легенді. Коли ввімкнено всі команди, той самий клік
   *  повертає дефолт — лише компанію. Правило — `teamKeys`, тримає `#10901`. */
  const teams = teamKeys(seriesList, showArchived);
  const allShown = teams.length > 1 && teams.every((k) => visibleKeys.has(k));
  const toggleAll = () => setShown(allShown ? null : new Set(teams));
  const archivedCount = seriesList.filter((s) => s.archived).length;

  // Межа осі Y — по видимому вікну, щоб поділки були круглими саме в тому, що бачимо.
  const yTicks = useMemo(() => {
    const windowRows = rows.slice(eff.lo, eff.hi + 1);
    let max = 0;
    for (const r of windowRows) {
      for (const { i } of visibleSeries) { const v = r[`s${i}`]; if (typeof v === "number" && v > max) max = v; }
    }
    return niceTicks(max);
  }, [rows, eff.lo, eff.hi, visibleSeries]);

  /** Поділки кожної осі — по ЇЇ лініях у видимому вікні (гривні не стискають штуки до нуля). */
  const axisTicks = useMemo(() => {
    const windowRows = rows.slice(eff.lo, eff.hi + 1);
    const maxOf = (axis: "left" | "right") => {
      let max = 0;
      for (const r of windowRows) for (const l of lines) if (l.yAxisId === axis) { const v = r[l.dataKey]; if (typeof v === "number" && v > max) max = v; }
      return niceTicks(max);
    };
    return { left: maxOf("left"), right: lines.some((l) => l.yAxisId === "right") ? maxOf("right") : null };
  }, [rows, eff.lo, eff.hi, lines]);
  const axisUnit = (axis: "left" | "right") => lines.find((l) => l.yAxisId === axis)?.unit;
  const refAxis = multi ? "left" : 0;
  /** Чи є у вікні хоч одна точка видимих серій — інакше графік порожній, і це кажемо словами. */
  const hasPoints = useMemo(() => rows.slice(eff.lo, eff.hi + 1).some((r) => (multi
    ? lines.some((l) => r[l.dataKey] != null)
    : visibleSeries.some(({ i }) => r[`s${i}`] != null))),
  [rows, eff.lo, eff.hi, visibleSeries, multi, lines]);

  const anomalyAt = (period: string) => (resp?.anomalies ?? []).filter((a) => a.period === period && visibleKeys.has(a.scopeKey));
  /** Порожня точка — лише на періоді, що йде (кінець пунктиру), з кільцем кольору фону. */
  const curDot = (c: string) => (p: any) => (p?.payload?.period >= curStart && typeof p.cx === "number" && typeof p.cy === "number"
    ? <circle key={`cur${p.index}`} cx={p.cx} cy={p.cy} r={4} fill="var(--card-bg)" stroke={c} strokeWidth={2} />
    : <g key={`n${p?.index ?? 0}`} />);

  const onDragEnd = () => {
    if (drag.a && drag.b && drag.a !== drag.b) {
      const ia = rows.findIndex((r) => r.period === drag.a), ib = rows.findIndex((r) => r.period === drag.b);
      let lo = Math.min(ia, ib), hi = Math.max(ia, ib);
      if (hi - lo < MIN_WIN) hi = Math.min(rows.length - 1, lo + MIN_WIN);
      setWin({ lo, hi, key: winKey });
    }
    setDrag({ a: null, b: null });
  };

  const segBtn = (on: boolean, disabled = false) => ({ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: disabled ? "not-allowed" : "pointer", border: "none",
    opacity: disabled ? 0.4 : 1, background: on ? "#1f2330" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" } as const);

  /* 🧭 Розгорнути показник з картки: крок графіка — той самий, що в картки (місяць / тиждень). */
  const openMetric = (k: string) => { setMetricKey(k); setGran(cardGran); setShown(null); setRange(cardGran === "month" ? "12м" : "3м"); };
  const railBtn = (on: boolean) => ({ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left" as const, fontSize: 14, fontWeight: 700,
    padding: "9px 12px", borderRadius: 11, cursor: "pointer", border: on ? "1px solid #1f2330" : "1px solid var(--border)",
    background: on ? "#1f2330" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" });

  return (
    <div>
      <h1 className="page-title">📊 Статистики</h1>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", marginTop: 18 }}>
      {/* Відділи — ліворуч (погоджений макет «стіна графіків»). */}
      {/* 🙈 ВКЛАДКА «Ручні» (✍️) НЕ ПОКАЗУЄТЬСЯ — рішення власника 08.09.2026: «щоб у
          ручному нічого не заповнювали». 🔴 ЗАПИС У `CATS` ЛИШАЄТЬСЯ, ПРИБРАНО ЛИШЕ ВХІД: на нього
          спирається `ManualForm` (`CATS.find(c => c.key === "manual")!`).
          ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: це фронт, тож `POST /statistics/manual` лишається
          живим для адміна. Тобто вхід прибрано з ЕКРАНА, а не з API. */}
      <nav style={{ flex: "0 0 210px", display: "flex", flexDirection: "column", gap: 6 }}>
        <button type="button" onClick={() => { setCatKey("mine"); setMetricKey(null); setShown(null); }} style={railBtn(catKey === "mine")}>
          <span>★</span> Мій набір <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>{mine.length || ""}</span>
        </button>
        {/* ⚠️ ЛАНЦЮГ `CATS.filter((c) => !c.manualForm).map(` НЕ РОЗРИВАТИ: його читає гейт #363b. */}
        {CATS.filter((c) => !c.manualForm).map((c) => (
          <button key={c.key} onClick={() => { setCatKey(c.key); setMetricKey(null); setShown(null); }} style={railBtn(catKey === c.key)}>
            <span>{c.icon}</span> {c.label} <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>{c.metrics.length}</span>
          </button>
        ))}
      </nav>

      <div style={{ flex: "1 1 620px", minWidth: 0 }}>
      {!cat.manualForm && !metric && (
        <StatsWall cat={cat} gran={cardGran} setGran={setCardGran} today={today} onOpen={openMetric}
          mine={mine} saveMine={saveMine} isMine={catKey === "mine"}
          view={wallView} setView={saveWallView} period={stackPeriod} setPeriod={setStackPeriod} />
      )}

      {!cat.manualForm && metric && (
        <button type="button" onClick={() => setMetricKey(null)}
          style={{ fontSize: 13, fontWeight: 650, padding: "6px 12px", borderRadius: 9, cursor: "pointer", border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", marginBottom: 10 }}>
          ← {cat.icon} {cat.label}: усі показники
        </button>
      )}
      {!cat.manualForm && metric && (
        <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px" }}>
          {/* Чипи метрик. Формула — у ⓘ біля назви графіка (ТЗ 14.10, п.1: «тексту на екрані немає»). */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {cat.metrics.map((m) => (
              <button key={m.key} onClick={() => { setMetricKey(m.key); setShown(null); }}
                style={{ fontSize: 13, fontWeight: 650, padding: "7px 13px", borderRadius: 20, cursor: "pointer",
                  border: metricKey === m.key ? "1px solid #2f6fdb" : "1px solid var(--border)",
                  background: metricKey === m.key ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: metricKey === m.key ? "#2f6fdb" : "var(--text)" }}>
                {m.label}
              </button>
            ))}
            {/* 📈 «＋ Показник» (5707 п.2): галочки по групах; недоступний пункт — вимкнений із причиною словами. */}
            {!metric.unitScope && (
              <span style={{ position: "relative" }}>
                <button type="button" onClick={() => setPickerOpen((o) => !o)} title={`до ${MAX_METRICS} показників на одному графіку`}
                  style={{ fontSize: 13, fontWeight: 650, padding: "7px 13px", borderRadius: 20, cursor: "pointer", border: "1px dashed var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                  ＋ Показник з будь-якого відділу{extras.length ? ` (${chosen.length} з ${MAX_METRICS})` : ""}
                </button>
                {pickerOpen && (
                  <div role="dialog" style={{ position: "absolute", zIndex: 30, top: "110%", left: 0, width: 340, maxWidth: "calc(100vw - 32px)", maxHeight: 380, overflowY: "auto", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                    <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>До {MAX_METRICS} показників, не більше двох одиниць (ліва й права вісь).</div>
                    {CATS.filter((c) => !c.manualForm && c.metrics.some((m) => !m.unitScope)).map((c) => (
                      <div key={c.key} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 750, margin: "4px 0 2px" }}>{c.icon} {c.label}</div>
                        {c.metrics.filter((m) => !m.unitScope).map((m) => {
                          const isMain = m.key === metric.key;
                          const on = isMain || extraKeys.includes(m.key);
                          const verdict = on ? null : canAdd(chosen, m);
                          const off = isMain || (verdict != null && !verdict.ok);
                          const why = isMain ? "основний показник графіка" : verdict && !verdict.ok ? verdict.reason : undefined;
                          return (
                            <label key={m.key} title={why} style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5, padding: "2px 0", cursor: off ? "not-allowed" : "pointer", opacity: off && !on ? 0.5 : 1 }}>
                              <input type="checkbox" checked={on} disabled={off}
                                onChange={() => setExtraKeys((ks) => (ks.includes(m.key) ? ks.filter((k) => k !== m.key) : [...ks, m.key]))} />
                              <span>{m.label}{m.unit ? `, ${m.unit}` : ""}{off && !isMain && why ? <span style={{ display: "block", fontSize: 11, color: MUTED }}>{why}</span> : null}</span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </span>
            )}
          </div>

          {/* 🎛 КЕРУВАННЯ — ДВІ ПІДПИСАНІ ГРУПИ, однакові на всіх вкладках (ТЗ, блок 4, п.2). Недоступний крок
              видно вимкненим із поясненням, а не прибраним — інакше набір кнопок «стрибає» між вкладками. */}
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", margin: "12px 0 10px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 700 }}>Крок:</span>
              <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                {(["day", "week", "month"] as const).map((g) => {
                  const off = (metric.monthOnly && g !== "month") || (metric.weekOnly && g !== "week");
                  return (
                    <button key={g} disabled={off} title={off ? (metric.monthOnly ? "цей показник є лише помісячно" : "цей показник є лише по тижнях") : undefined}
                      onClick={() => setGran(g)} style={segBtn(effGran === g, off)}>
                      {g === "day" ? "День" : g === "week" ? "Тиждень" : "Місяць"}
                    </button>
                  );
                })}
              </span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 700 }}>Період:</span>
              <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                {Object.keys(RANGES).map((r) => (
                  <button key={r} onClick={() => { setRange(r); setWin(null); }} style={segBtn(range === r)}>{r === "Усе" ? "Усе" : r.replace("м", " міс")}</button>
                ))}
              </span>
            </span>
          </div>

          {/* Серії: дефолт — компанія; команди додаються кліком. Розформовані — лише з «показати архівні». */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            {!multi && legendKeys.length > 1 && (teams.length > 1 ? (
              <button type="button" onClick={toggleAll}
                style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                {allShown ? "Лише компанія" : "Усі команди"}
              </button>
            ) : null)}
            {seriesList.map((s, i) => (s.archived && !showArchived) ? null : (
              <span key={s.scopeKey} onClick={() => (multi ? isolate(s.scopeKey) : toggle(s.scopeKey))} onDoubleClick={() => isolate(s.scopeKey)}
                title={multi ? "кілька показників — один розріз: клік обирає цей" : s.benchmark ? "бенчмарк — агрегат компанії (для порівняння)" : "клік — показати / сховати · подвійний — лише ця"}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, cursor: "pointer", opacity: isDrawn(s.scopeKey) ? 1 : 0.4, userSelect: "none", color: s.benchmark ? MUTED : "var(--text)" }}>
                {multi
                  ? <span style={{ width: 11, height: 11, borderRadius: "50%", border: "2px solid var(--text)", background: isDrawn(s.scopeKey) ? "var(--text)" : "transparent" }} />
                  : s.benchmark
                  ? <span style={{ width: 14, height: 0, borderTop: "2px dashed #94a3b8" }} />
                  : <span style={{ width: 14, height: 3, borderRadius: 2, background: color(i) }} />}
                {isDrawn(s.scopeKey) || multi ? "" : "+ "}{s.scopeName}{s.benchmark && " (бенчмарк)"}
              </span>
            ))}
            {archivedCount > 0 && (
              <label style={{ fontSize: 12, color: MUTED, cursor: "pointer" }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> показати архівні
              </label>
            )}
            {!resp && !loadErr && <SkelBox w={420} h={14} />}
            {scopesLoading && <span style={{ fontSize: 12, color: MUTED }}>інші розрізи довантажуються…</span>}
            {asOfLabel(resp?.asOf, today) && <span style={{ marginLeft: "auto", fontSize: 12, color: MUTED }} title="коли сервер порахував ці ряди; перерахунок іде у фоні раз на 10 хв">станом на {asOfLabel(resp?.asOf, today)}</span>}
          </div>

          {/* 🏷 НАЗВА ПОКАЗНИКА НАД ГРАФІКОМ, як рахується — лише в ⓘ (ТЗ 14.10, п.1). */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 750, margin: "4px 0 2px" }}>
            {metric.label}
            <InfoHint text={[metric.hint, metric.seamHint, SEAM_NOTE].filter(Boolean).join(" · ")} />
          </div>
          {multi && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, fontWeight: 650, margin: "2px 0 4px" }}>
              {lines.map((l, j) => (
                <span key={l.dataKey} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 14, height: 3, borderRadius: 2, background: color(j) }} />
                  {l.label} <span style={{ color: MUTED, fontWeight: 500 }}>· {l.yAxisId === "left" ? "ліва" : "права"} вісь</span>
                  {j > 0 && <InfoHint text={chosen[j]?.hint ?? ""} />}
                  {j > 0 && <button type="button" title="прибрати з графіка" onClick={() => setExtraKeys((ks) => ks.filter((k) => k !== l.metricKey))}
                    style={{ border: "none", background: "none", cursor: "pointer", color: MUTED, fontSize: 14, padding: 0 }}>×</button>}
                </span>
              ))}
              {extraErr && <span role="alert" style={{ color: "#b91c1c" }}>⚠️ доданий показник не завантажився: {extraErr}</span>}
            </div>
          )}

          {loadErr ? (
            <div role="alert" style={{ padding: "18px 0", color: "#b91c1c", fontSize: 13 }}>
              ⚠️ Графік не завантажився: {loadErr}.{" "}
              <button onClick={() => setNonce((n) => n + 1)} style={{ fontSize: 12.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>Повторити</button>
            </div>
          ) : (chartLoading || !resp) ? (
            <ChartSkeleton height={300} />
          ) : (
            <>
              <div style={{ userSelect: "none" }}>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={rows} key={chartVer} margin={{ top: 12, right: 64, bottom: 4, left: 8 }}
                    onMouseDown={(e: any) => e && setDrag({ a: e.activeLabel, b: e.activeLabel })}
                    onMouseMove={(e: any) => e && drag.a && setDrag((d) => ({ ...d, b: e.activeLabel }))}
                    onMouseUp={onDragEnd}>
                    {/* Сітка — суцільна волосинка: пунктир читається як «прогноз» або «поріг», а це лише сітка. */}
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="period" tickFormatter={(p) => periodTick(String(p), effGran)} tick={{ fontSize: 11, fill: MUTED }} minTickGap={40} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                    {multi ? (
                      [<YAxis key="yl" yAxisId="left" ticks={axisTicks.left} domain={[0, axisTicks.left[axisTicks.left.length - 1]]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => axisFmt(Number(v), axisUnit("left"))} axisLine={false} tickLine={false} width={58} />,
                       axisTicks.right && <YAxis key="yr" yAxisId="right" orientation="right" ticks={axisTicks.right} domain={[0, axisTicks.right[axisTicks.right.length - 1]]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => axisFmt(Number(v), axisUnit("right"))} axisLine={false} tickLine={false} width={58} />]
                    ) : (
                      <YAxis ticks={yTicks} domain={[0, yTicks[yTicks.length - 1]]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => axisFmt(Number(v), metric.unit)} axisLine={false} tickLine={false} width={58} />
                    )}
                    {/* 💬 Одна підказка на всі лінії: значення — головне, назва — другорядна; ключ лінії — короткий штрих її
                        кольору, а текст — кольором тексту (світлі кольори ліній як текст на білому не читаються). Значення
                        береться з рядка, а не з лінії, тож суцільна й пунктирна половини однієї серії не двоять рядок. */}
                    <Tooltip
                      content={({ active, payload, label }: any) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0]?.payload ?? {};
                        const an = anomalyAt(String(label));
                        const items = multi
                          ? lines.map((l, j) => ({ key: l.dataKey, name: l.label, unit: l.unit, color: color(j), dashed: false }))
                          : visibleSeries.map(({ s, i }) => ({ key: `s${i}`, name: s.scopeName, unit: metric.unit, color: s.benchmark ? "#94a3b8" : color(i), dashed: !!s.benchmark }));
                        return (
                          <div style={{ fontSize: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", padding: "8px 10px", maxWidth: 340 }}>
                            <div style={{ color: MUTED, marginBottom: 3 }}>{periodTitle(String(label), effGran)}{String(label) >= curStart && <> · іде, станом на {shortDate(today)}</>}</div>
                            {items.filter((it) => typeof row[it.key] === "number").map((it) => (
                              <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 12, height: 0, borderTop: `2px ${it.dashed ? "dashed" : "solid"} ${it.color}`, flex: "none" }} />
                                <b>{fmt(Number(row[it.key]), it.unit)}</b>
                                <span style={{ color: MUTED }}>{it.name}</span>
                              </div>
                            ))}
                            {an.map((a, k) => (
                              <div key={k} style={{ marginTop: 4, color: a.kind === "real" ? "#b45309" : a.kind === "corrected" ? "#1d4ed8" : "#b91c1c" }}>{a.kind === "corrected" ? "✏️" : "⚠️"} {a.note}<br /><span style={{ color: MUTED }}>{a.crm}</span></div>
                            ))}
                          </div>
                        );
                      }} />
                    {/* 🪡 Підпису шва 01.07 більше немає: таблиці на графіку немає, тож і зміни джерела всередині ряду немає. */}
                    {/* Кілька показників: лінія на показник, вісь — за ОДИНИЦЕЮ показника (`multiLines`). */}
                    {/* Лінії — прямими відрізками між точками (`linear`): точки — суми за період, а згладжена крива
                        вигадувала проміжні значення й горби між ними. Кожна серія — дві лінії: суцільна по повних
                        періодах і пунктир від останнього повного до того, що йде (порожня точка на кінці). */}
                    {multi && lines.map((l, j) => (
                      <Line key={l.dataKey} yAxisId={l.yAxisId} type="linear" dataKey={l.dataKey + FULL_SUFFIX} name={l.label}
                        stroke={color(j)} strokeWidth={j === 0 ? 2.4 : 2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {multi && lines.map((l, j) => (
                      <Line key={l.dataKey + CUR_SUFFIX} yAxisId={l.yAxisId} type="linear" dataKey={l.dataKey + CUR_SUFFIX} name={l.label} legendType="none"
                        stroke={color(j)} strokeWidth={2} strokeDasharray="5 4" dot={curDot(color(j))} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {!multi && visibleSeries.map(({ s, i }) => (
                      <Line key={s.scopeKey} type="linear" dataKey={`s${i}${FULL_SUFFIX}`} name={s.scopeName}
                        stroke={s.benchmark ? "#94a3b8" : color(i)} strokeWidth={s.benchmark ? 1.6 : i === 0 ? 2.4 : 2}
                        strokeDasharray={s.benchmark ? "6 4" : undefined} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {!multi && visibleSeries.map(({ s, i }) => (
                      <Line key={s.scopeKey + CUR_SUFFIX} type="linear" dataKey={`s${i}${CUR_SUFFIX}`} name={s.scopeName} legendType="none"
                        stroke={s.benchmark ? "#94a3b8" : color(i)} strokeWidth={s.benchmark ? 1.6 : 2}
                        strokeDasharray={s.benchmark ? "2 3" : "5 4"} dot={curDot(s.benchmark ? "#94a3b8" : color(i))} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {/* ⚠️ Аномалії з доказом CRM (ТЗ, блок 1, п.3) — точка помічена, а не лінія тягнеться мовчки. */}
                    {(resp.anomalies ?? []).flatMap((a, k) => {
                      const si = seriesList.findIndex((s) => s.scopeKey === a.scopeKey);
                      if (si < 0 || !visibleKeys.has(a.scopeKey)) return [];
                      if (multi && a.scopeKey !== multiScope) return [];
                      const v = rows.find((r) => r.period === a.period)?.[multi ? "m0" : `s${si}`];
                      const fill = a.kind === "real" ? "#f59e0b" : a.kind === "corrected" ? "#2563eb" : "#dc2626";
                      return typeof v === "number" ? [<ReferenceDot key={`an${k}`} yAxisId={refAxis} x={a.period} y={v} r={6} fill={fill} stroke="#fff"
                        label={{ value: a.kind === "corrected" ? "✎" : "!", position: "top", fontSize: 12, fontWeight: 800, fill }} />] : [];
                    })}
                    {/* ⏳ Період, що йде, — затінений і підписаний «іде»: інакше неповний місяць на великому графіку читається як обвал. */}
                    {(() => {
                      const last = rows[eff.hi], prev = rows[eff.hi - 1];
                      return last && prev && String(last.period) >= curStart
                        ? <ReferenceArea yAxisId={refAxis} x1={prev.period} x2={last.period} fill="#94a3b8" fillOpacity={0.12} label={{ value: "іде", position: "insideTop", fontSize: 11, fill: MUTED }} />
                        : null;
                    })()}
                    {drag.a && drag.b && <ReferenceArea yAxisId={refAxis} x1={drag.a} x2={drag.b} fill="#2f6fdb" fillOpacity={0.08} />}
                    <Brush dataKey="period" height={24} travellerWidth={9} stroke="#94a3b8" tickFormatter={(p) => periodTick(String(p), effGran)}
                      startIndex={eff.lo} endIndex={eff.hi} gap={1}
                      onChange={(e: any) => {
                        if (!e || e.startIndex == null || e.endIndex == null) return;
                        let lo = e.startIndex, hi = e.endIndex;
                        if (lo === eff.lo && hi === eff.hi) return;
                        if (hi - lo < MIN_WIN) {
                          if (lo + MIN_WIN <= rows.length - 1) hi = lo + MIN_WIN; else lo = Math.max(0, hi - MIN_WIN);
                        }
                        setWin({ lo, hi, key: winKey });
                      }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {!hasPoints && <div style={{ padding: "12px 0", color: MUTED, fontSize: 13 }}>У вибраному вікні немає точок для цього показника.</div>}
              {multi && <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{MULTI_NOTE}</div>}
              {/* 🔢 Таблиця значень (макет, п.3): ті самі точки, що в видимому вікні графіка, нові — зверху. */}
              <ValuesTable rows={rows.slice(eff.lo, eff.hi + 1)} curStart={curStart} gran={effGran}
                cols={multi
                  ? lines.map((l, j) => ({ key: l.dataKey, label: l.label, unit: l.unit, color: color(j) }))
                  : visibleSeries.map(({ s, i }) => ({ key: `s${i}`, label: s.scopeName, unit: metric.unit, color: s.benchmark ? "#94a3b8" : color(i) }))} />
            </>
          )}
        </div>
      )}

      {cat.manualForm && <ManualForm onClose={() => { setCatKey("sales"); setMetricKey(null); }} isAdmin={role === "admin"} />}

      {/* 📉 «Купував минулого місяця, не купив у цьому» — у Логістиці, поруч із постійними клієнтами. */}
      {catKey === "logistics" && !metric && <LapsedClientsBlock />}
      </div>
      </div>
    </div>
  );
}

/** 🔢 Значення по періодах — під розгорнутим графіком, рівно ті самі періоди, що у вікні (нові — зверху; довге вікно
 *  гортається всередині таблиці — раніше вона мовчки обрізалась до 24 рядків). Період, що йде, підписаний: його число ще росте. */
function ValuesTable({ rows, cols, curStart, gran }: { rows: any[]; cols: { key: string; label: string; unit?: string; color: string }[]; curStart: string; gran: "day" | "week" | "month" }) {
  if (!rows.length || !cols.length) return null;
  const list = [...rows].reverse();
  return (
    <div style={{ marginTop: 12, maxHeight: 320, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
      <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
        <thead><tr><th style={{ textAlign: "left" }}>Період</th>{cols.map((c) => (
          <th key={c.key} style={{ textAlign: "right" }}><span style={{ display: "inline-block", width: 12, height: 3, borderRadius: 2, background: c.color, marginRight: 5, verticalAlign: "middle" }} />{c.label}</th>
        ))}</tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.period}>
            <td>{periodTitle(r.period, gran)}{r.period >= curStart && <span style={{ color: MUTED }}> · іде</span>}</td>
            {cols.map((c) => <td key={c.key} style={{ textAlign: "right" }}>{typeof r[c.key] === "number" ? fmt(r[c.key], c.unit) : <span style={{ color: MUTED }}>—</span>}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

type CardState = { resp?: StatsSeriesResp; err?: string };
/** Памʼять карток у вкладці (`makeCardMemo`): 10 хв — стільки ж, скільки сервер тримає ряд без перерахунку. */
const cardMemo = makeCardMemo<StatsSeriesResp>(10 * 60_000);

/**
 * 🧱 СТІНА ВІДДІЛУ: усі показники картками одразу. Кожна картка — свій легкий запит (`scope=main`), тож одна повільна
 * чи заборонена не тримає інших. Цифри — `cardFigures` (останній повний період, попередній повний, той, що йде).
 */
function StatsWall({ cat, gran, setGran, today, onOpen, mine, saveMine, isMine, view, setView, period, setPeriod }: {
  cat: Cat; gran: CardGran; setGran: (g: CardGran) => void; today: string; onOpen: (k: string) => void;
  mine: string[]; saveMine: (ks: string[]) => void; isMine: boolean;
  view: WallView; setView: (v: WallView) => void; period: StackPeriod; setPeriod: (p: StackPeriod) => void;
}) {
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [editing, setEditing] = useState(false);
  const keyList = cat.metrics.map((m) => m.key).join("|");
  /* ☰ Стовпчик питає ТІ САМІ ряди, що картки (`wallFrom`): перемикання вигляду запиту не робить. Лише «Усе» бере ряд
     на всю глибину — його фон теж тримає готовим. Тож ефект залежить не від вигляду, а від того, чи потрібна глибина. */
  const per = effStackPeriod(period, gran);
  const deep = wallFrom(today, gran, view, per) === undefined;
  useEffect(() => {
    let alive = true;
    const reqs = cat.metrics.map((m) => {
      const g = effGranOf(m, gran), from = wallFrom(today, g === "week" ? "week" : "month", view, per);
      return { m, g, from, key: `${m.block}|${m.key}|${g}|${from ?? "all"}` };
    });
    /* 🗂 Спершу — що вже є у вкладці (повернення до відділу без заготовок), далі свіжа відповідь підміняє картку. */
    setCards(Object.fromEntries(reqs.flatMap((r) => { const hit = cardMemo.get(r.key); return hit ? [[r.m.key, { resp: hit }]] : []; })));
    for (const r of reqs) {
      fetchStatsSeries({ block: r.m.block, metric: r.m.key, granularity: r.g, from: r.from, scope: "main" })
        .then((d) => { cardMemo.set(r.key, d); if (alive) setCards((c) => ({ ...c, [r.m.key]: { resp: d } })); })
        .catch((e) => alive && setCards((c) => ({ ...c, [r.m.key]: { err: errText(e) } })));
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyList, gran, today, deep]);
  /* «Усе»: спільний початок осі — найраніший період серед графіків того самого кроку, щоб місяці стояли один під одним. */
  const earliest = useMemo(() => {
    const out: Partial<Record<CardGran, string>> = {};
    for (const m of cat.metrics) {
      const g: CardGran = effGranOf(m, gran) === "week" ? "week" : "month";
      for (const p of cards[m.key]?.resp?.series[0]?.points ?? []) if (!out[g] || p.period < out[g]!) out[g] = p.period;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, keyList, gran]);
  const seg = (on: boolean) => ({ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: "pointer", border: "none",
    background: on ? "#1f2330" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" } as const);
  const toggleMine = (k: string) => saveMine(mine.includes(k) ? mine.filter((x) => x !== k) : [...mine, k].slice(0, MINE_MAX));

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 17, fontWeight: 800 }}>{cat.icon} {cat.label}</span>
        <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
          <button type="button" onClick={() => setGran("month")} style={seg(gran === "month")}>Місяць</button>
          <button type="button" onClick={() => setGran("week")} style={seg(gran === "week")}>Тиждень</button>
        </span>
        <InfoHint text={view === "stack" ? STACK_NOTE : WALL_NOTE} />
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {view === "stack" && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12.5, color: MUTED }}>Період</span>
              <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                {stackPeriods(gran).map((o) => (
                  <button key={o.key} type="button" aria-pressed={per === o.key} onClick={() => setPeriod(o.key)} style={seg(per === o.key)}>{o.label}</button>
                ))}
              </span>
            </span>
          )}
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: MUTED }}>Вигляд</span>
            <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
              <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")} style={seg(view === "cards")}>▦ Картки</button>
              <button type="button" aria-pressed={view === "stack"} onClick={() => setView("stack")} style={seg(view === "stack")}>☰ Один під одним</button>
            </span>
          </span>
        </span>
        {isMine && (
          <button type="button" onClick={() => setEditing((e) => !e)}
            style={{ fontSize: 13, fontWeight: 650, padding: "6px 12px", borderRadius: 9, cursor: "pointer", border: "1px dashed var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
            {editing ? "Готово" : "Обрати показники"}
          </button>
        )}
      </div>

      {isMine && (editing || !mine.length) && (
        <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8 }}>
            Галочками — будь-які показники з усіх відділів (до {MINE_MAX}). Набір зберігається в цьому браузері.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "4px 18px" }}>
            {CATS.filter((c) => !c.manualForm).map((c) => (
              <div key={c.key}>
                <div style={{ fontSize: 12, fontWeight: 750, margin: "6px 0 2px" }}>{c.icon} {c.label}</div>
                {c.metrics.map((m) => (
                  <label key={m.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, padding: "2px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={mine.includes(m.key)} onChange={() => toggleMine(m.key)} /> {m.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "stack" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cat.metrics.map((m) => (
            <StackRow key={m.key} m={m} st={cards[m.key]} gran={gran} today={today} period={per} earliest={earliest} onOpen={() => onOpen(m.key)} />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
          {cat.metrics.map((m) => <WallCard key={m.key} m={m} st={cards[m.key]} gran={gran} today={today} onOpen={() => onOpen(m.key)} />)}
        </div>
      )}
    </div>
  );
}

/**
 * 🔢 ЦИФРИ ПОКАЗНИКА СТІНИ — ОДИН РАЗ НА ОБИДВА ВИГЛЯДИ. Картка й рядок «Один під одним» беруть число, зміну й період,
 * що йде, з цієї функції та малюють їх одним блоком (`CardNumbers`): двох способів порахувати «жовтень» на екрані немає.
 */
function cardOf(m: Metric, st: CardState | undefined, gran: CardGran, today: string) {
  const g: CardGran = effGranOf(m, gran) === "week" ? "week" : "month";
  const series = st?.resp?.series[0];
  const points = series?.points ?? [];
  const f = cardFigures(points, g, today);
  const dl = cardDelta(f.last, f.prev, m.unit, m.better);
  /** Є що малювати графіком: відповідь прийшла, серія у розрізі глядача є, точки є. */
  const ok = !st?.err && !!series && points.length > 0;
  return { g, series, points, f, dl, ok };
}
type CardOf = ReturnType<typeof cardOf>;

function CardHead({ m }: { m: Metric }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
      <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>{m.label}</span>
      {/* Джерело — лише коли воно НЕ CRM: однакова плашка «CRM» на кожній картці була шумом (ⓘ біля «Місяць / Тиждень» каже, що без позначки — CRM). */}
      {srcOf(m) !== "CRM" && <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: "var(--border)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{srcOf(m)}</span>}
    </div>
  );
}

function CardNumbers({ m, st, c, today }: { m: Metric; st?: CardState; c: CardOf; today: string }) {
  const { g, series, points, f, dl } = c;
  if (st?.err) return <div role="alert" style={{ color: "#b91c1c", fontSize: 12.5, marginTop: 8 }}>⚠️ {st.err}</div>;
  if (!st) return <SkelBox w="70%" h={26} style={{ marginTop: 10 }} />;
  if (!series) return <div style={{ color: MUTED, fontSize: 12.5, marginTop: 8 }}>у вашому розрізі цього показника немає</div>;
  if (!points.length) return (
    <div style={{ color: MUTED, fontSize: 12.5, marginTop: 8 }}>
      {m.companyOnly && series.scopeType !== "company" ? "лише по компанії — по команді не розрізається" : "за останні періоди точок немає"}
    </div>
  );
  return (
    <>
      {f.last ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{fmt(f.last.value, m.unit)}</div>
          <div style={{ fontSize: 12, color: MUTED }}>{periodLabel(f.last.period, g)}{series.scopeType !== "company" ? ` · ${series.scopeName}` : ""}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 3, color: dl?.tone === "good" ? "#16a34a" : dl?.tone === "bad" ? "#dc2626" : MUTED }}>
            {dl == null ? "немає з чим порівняти" : `${dl.text} ${prevLabel(f.prev!.period, g)}`}
          </div>
          {f.missingSince && <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 3 }}>після {periodLabel(f.missingSince, g)} даних немає</div>}
        </>
      ) : <div style={{ color: MUTED, fontSize: 12.5, marginTop: 8 }}>повних періодів ще немає</div>}
      <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
        {g === "month" ? MONTHS[Number(f.currentStart.slice(5, 7)) - 1] : `тиждень ${dm(f.currentStart)}`} іде:{" "}
        {f.current ? <b style={{ color: "var(--text)" }}>{fmt(f.current.value, m.unit)}</b> : "точок ще немає"} станом на {dm(today)}{asOfLabel(st?.resp?.asOf, today) ? `, ${asOfLabel(st?.resp?.asOf, today)}` : ""}
      </div>
    </>
  );
}

function WallCard({ m, st, gran, today, onOpen }: { m: Metric; st?: CardState; gran: CardGran; today: string; onOpen: () => void }) {
  const c = cardOf(m, st, gran, today);
  const box = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px", cursor: "pointer", textAlign: "left" as const, color: "var(--text)", font: "inherit" };
  return (
    <button type="button" onClick={onOpen} style={box} title="клік — розгорнути: графік, команди, таблиця значень">
      <CardHead m={m} />
      <CardNumbers m={m} st={st} c={c} today={today} />
      {c.ok && <StatsMiniChart points={c.points} currentStart={c.f.currentStart} />}
    </button>
  );
}

/**
 * ☰ РЯДОК ВИГЛЯДУ «ОДИН ПІД ОДНИМ»: ліворуч — ті самі цифри, що на картці (`cardOf` + `CardNumbers`, інших чисел тут
 * немає), праворуч — графік показника на спільній осі часу (`stackWindow`). «Розгорнути» веде у великий графік з
 * командами, як клік по картці.
 */
function StackRow({ m, st, gran, today, period, earliest, onOpen }: {
  m: Metric; st?: CardState; gran: CardGran; today: string; period: StackPeriod; earliest: Partial<Record<CardGran, string>>; onOpen: () => void;
}) {
  const c = cardOf(m, st, gran, today);
  const rows = c.ok ? stackWindow(c.points, period, c.g, today, earliest[c.g]) : [];
  const vals = rows.flatMap((r) => (r.value == null ? [] : [r.value]));
  const ticks = vals.length && Math.min(...vals) >= 0 && Math.max(...vals) > 0 ? niceTicks(Math.max(...vals)) : undefined;
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px" }}>
      <div style={{ flex: "0 0 220px", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <CardHead m={m} />
        <CardNumbers m={m} st={st} c={c} today={today} />
        {/* Показник без тижневого ряду у вигляді «Тиждень» лишається помісячним — кажемо це, бо вісь у нього інша. */}
        {c.g !== gran && <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>лише помісячно</div>}
        <button type="button" onClick={onOpen} title="графік, команди, таблиця значень"
          style={{ marginTop: "auto", padding: "8px 0 0", alignSelf: "flex-start", font: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: "none", background: "none", color: "#2563eb" }}>
          Розгорнути →
        </button>
      </div>
      <div style={{ flex: "1 1 380px", minWidth: 0 }}>
        {c.ok
          ? <StatsStackChart rows={rows} g={c.g} unit={m.unit} currentStart={c.f.currentStart} today={today} ticks={ticks} tickFmt={(v) => axisFmt(v, m.unit)} />
          : !st ? <SkelBox w="100%" h={STACK_CHART_HEIGHT} /> : null}
      </div>
    </div>
  );
}

function ManualForm({ onClose, isAdmin }: { onClose: () => void; isAdmin: boolean }) {
  const manualMetrics = CATS.find((c) => c.key === "manual")!.metrics;
  const [mk, setMk] = useState(manualMetrics[0].key);
  const m = manualMetrics.find((x) => x.key === mk)!;
  const [period, setPeriod] = useState("2026-07-01");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async () => {
    try { await saveStatsManual({ block: m.block, metric: m.key, scopeType: "company", scopeKey: "company", scopeName: "Компанія", granularity: "month", period, value: Number(value) }); setMsg("✓ Збережено"); setValue(""); }
    catch (e: any) { setMsg("✗ " + (e?.response?.data?.error ?? "помилка")); }
  };
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: 20, maxWidth: 560 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <b style={{ fontSize: 16 }}>✍️ Внести показники (ручні)</b>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: MUTED, fontSize: 18 }}>×</button>
      </div>
      {!isAdmin ? <div style={{ color: MUTED }}>Ввід доступний лише адміну.</div> : (
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 13 }}>Показник
            <select value={mk} onChange={(e) => setMk(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
              {manualMetrics.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>Місяць
            <input type="month" value={period.slice(0, 7)} onChange={(e) => setPeriod(e.target.value + "-01")} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          </label>
          <label style={{ fontSize: 13 }}>Значення {m.unit && `(${m.unit})`}
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          </label>
          <button onClick={submit} disabled={!value} style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: "#2f6fdb", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Зберегти</button>
          {msg && <div style={{ fontSize: 13, color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{msg}</div>}
          <div style={{ fontSize: 12, color: MUTED }}>Finance/HR вносяться в наявному розділі «Статистики (відділи)» (депстат) — тут не дублюємо.</div>
        </div>
      )}
    </div>
  );
}

/**
 * 📉 «КУПУВАВ МИНУЛОГО МІСЯЦЯ, НЕ КУПИВ У ЦЬОМУ» по командах (задача 3990, п.3). Гроші й
 * правило — з бекенда (ядро), тут лише подача. Поточний місяць не завершений — підпис каже це
 * прямо, інакше список у середині місяця читався б як «втратили половину клієнтів».
 */
function LapsedClientsBlock() {
  const [data, setData] = useState<LapsedClientsResp | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState<string>("");
  useEffect(() => { let alive = true; fetchLapsedClients(month || undefined).then((d) => { if (alive) setData(d); }).catch((e) => setErr(String(e?.message ?? e))); return () => { alive = false; }; }, [month]);
  const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
  const label = (ym: string) => { const [y, m] = ym.split("-"); return `${["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"][Number(m) - 1]} ${y}`; };
  const shift = (d: number) => { const base = (data?.month ?? new Date().toISOString().slice(0, 7)); const [y, m] = base.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1 + d, 1)); setMonth(dt.toISOString().slice(0, 7)); };
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px", marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15 }}>📉 Купували {data ? label(data.prevMonth) : "минулого місяця"}, не купили {data ? label(data.month) : "у цьому"}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            гроші ① за анкером ядра, як на Звіті · команда — за ефективним менеджером клієнта
            {data && !data.monthComplete && <b style={{ color: "#b45309" }}> · поточний місяць не завершений — список зменшуватиметься до кінця місяця</b>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => shift(-1)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 13, minWidth: 90, textAlign: "center" }}>{data ? label(data.month) : "…"}</span>
          <button onClick={() => shift(1)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>›</button>
        </div>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
      {!data && !err && <TableSkeleton rows={6} />}
      {data && (
        <>
          <div style={{ fontSize: 13, marginBottom: 10 }}>Разом: <b>{data.total.clients}</b> клієнтів · минулого місяця принесли <b>{fmt(data.total.prevRevenue)} ₴</b></div>
          {data.teams.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Жоден клієнт минулого місяця не випав — або у вашому скоупі немає оплат за минулий місяць.</div>}
          <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Команда</th><th style={{ textAlign: "right" }}>Клієнтів</th><th style={{ textAlign: "right" }}>Принесли минулого місяця</th></tr></thead>
            <tbody>
              {data.teams.map((t) => { const k = String(t.teamId ?? "none"); const isOpen = open.has(k); return (
                <Fragment key={k}>
                  <tr onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} style={{ cursor: "pointer" }}>
                    <td style={{ fontWeight: 700 }}>{isOpen ? "▾" : "▸"} {t.teamName}</td>
                    <td style={{ textAlign: "right" }}>{t.clients}</td>
                    <td style={{ textAlign: "right" }}>{fmt(t.prevRevenue)} ₴</td>
                  </tr>
                  {isOpen && t.rows.map((r) => (
                    <tr key={r.clientKey} style={{ background: "rgba(0,0,0,0.02)" }}>
                      <td style={{ paddingLeft: 26 }}>{r.clientName}<span style={{ color: "var(--text-muted)" }}> · {r.manager ?? "без менеджера"}</span></td>
                      <td></td>
                      <td style={{ textAlign: "right" }}>{fmt(r.prevRevenue)} ₴</td>
                    </tr>
                  ))}
                </Fragment>
              ); })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
