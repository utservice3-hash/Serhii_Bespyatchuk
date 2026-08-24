import { pool } from "../db/pool.js";
import * as money from "../core/money.js";
import * as metrics from "../core/metrics.js";
import * as plans from "../core/plans.js";
import { getSettings } from "../routes/settings.js";
import { resolveNamedMonth, guardFuturePeriod, type ResolvedPeriod } from "./period.js";

/**
 * 🎯 БІЛИЙ СПИСОК МЕТРИК ДЛЯ AI (`get_metric`) — КРОК 4.
 *
 * НАВІЩО. Раніше AI сам писав SQL під кожне питання. Замір 31.07.2026 показав, чим це
 * закінчується: той самий промт двічі поспіль давав РІЗНІ цифри (конверсія реклами
 * 76.9% проти 11.8%), а навіть у стабільних прогонах чисельник розходився з ядром у
 * **1.9 разу**. Тобто AI відповідав цифрами, яких у дашборді немає.
 *
 * ПРАВИЛО ПРОЄКТУ: одна метрика = одна функція ядра. Тому тут НЕМАЄ жодного SQL —
 * лише виклики `core/money.ts`, `core/metrics.ts`, `core/plans.ts`. Це не друга
 * реалізація метрик, а тонкий диспетчер поверх єдиної.
 *
 * 🔴 ЩО ЗАБОРОНЕНО ДОДАВАТИ СЮДИ:
 *  1. Метрику, якої НЕМАЄ в ядрі. Немає функції → інструмент не робимо, питання
 *     чесно лишається за `query_db` з підписом «з дашбордом не звірено». Інакше ми
 *     створимо другу реалізацію метрики всередині AI — рівно те, чого уникаємо.
 *  2. Будь-який власний SQL. Ні «маленький підзапит», ні «тільки JOIN на managers».
 *  3. Функцію, що читає персональні дані (`users`, `one_on_ones`, `bank_accounts`,
 *     `tasks`, `app_settings`, `tracker_*`, `access_audit`) — ні прямо, ні через JOIN.
 *     Білий список — це наша межа доступу замість `SET ROLE` (роль діє лише для
 *     `query_db`). Перевіряється автоматично: `scripts/gateAiMetrics.ts` перехоплює
 *     весь SQL кожної метрики і падає, якщо побачить заборонену таблицю.
 *
 * ПРОСТЕЖУВАНІСТЬ: кожна метрика несе `source` («core.money.receivedMoney»), який
 * повертається у відповіді, щоб будь-яке розходження з дашбордом дебажилось за
 * хвилину — видно, яку саме функцію викликали.
 */

/**
 * ПЕРСОНАЛЬНІ таблиці: метрика не має торкатись їх НІКОЛИ — ні прямо, ні через JOIN.
 * Перевіряє `scripts/gateAiMetrics.ts`, трасуючи реальний SQL кожної функції ядра.
 */
export const FORBIDDEN_TABLES = [
  "users", "access_audit", "bank_accounts",
  "one_on_ones", "one_on_one_forms", "tracker_devices", "tracker_intervals", "tasks",
];

/**
 * КОНФІГ-таблиці: читає САМ диспетчер (нижче — `getSettings()` заради `adSources`),
 * і жодне їх значення не потрапляє в контекст моделі — вона бачить лише результат
 * метрики. Тому в `FORBIDDEN_TABLES` їх немає.
 * ⚠️ Для `query_db` різниця принципова: там SQL складає МОДЕЛЬ, тож `app_settings`
 * лишається під `REVOKE` для ролі `ai_readonly` — інакше модель могла б вичитати
 * конфіг напряму. Тут — наш код, там — її.
 * Гейт окремо перевіряє, що жодна функція ЯДРА до них не ходить (ходить лише диспетчер).
 */
export const CONFIG_TABLES = ["app_settings"];

export interface MetricArgs {
  /**
   * Місяць, названий БЕЗ року («червень»). Передавати САМЕ його замість from/to —
   * рік підставляє код (найближче минуле входження), а не модель. Див. `ai/period.ts`.
   */
  month?: string | null;
  from?: string | null;
  to?: string | null;
  manager?: string | null;
  team?: string | null;
  granularity?: "day" | "week" | "month" | null;
}

interface ResolvedScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
}

export interface MetricDef {
  /** Ім'я для моделі. */
  name: string;
  /** Функція ядра — потрапляє у відповідь як підпис джерела. */
  source: string;
  /** Однорядковий опис: ЩО це і коли брати. */
  desc: string;
  /** Чи має сенс `granularity` (день/тиждень/місяць). */
  granular?: boolean;
  run: (s: ResolvedScope, a: MetricArgs, adSources: string[]) => Promise<unknown>;
}

const g = (a: MetricArgs, d: "day" | "week" | "month" = "month") => a.granularity ?? d;

/**
 * Скоуп для ЗНІМКОВИХ метрик. `SnapshotScope` у ядрі навмисно забороняє from/to
 * (`from?: never`) — такі метрики завжди «станом на зараз», періоду не мають. Тут
 * ми лише скидаємо дати, а НЕ підсовуємо їх обхідним шляхом: підсунути період
 * знімковій метриці = зробити з неї недатований знімок у сумах, від чого ми пішли
 * в КРОЦІ 2 (знімок мутував минулі місяці).
 */
const snap = (s: ResolvedScope) => ({ managerId: s.managerId ?? null, teamId: s.teamId ?? null });

/** Місяць плану з `from` (або поточний київський), у форматі YYYY-MM-01. */
const planMonth = (s: ResolvedScope) =>
  (s.from ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" })).slice(0, 7) + "-01";

/**
 * Реєстр. Порядок — тематичний: гроші → середній чек → сегменти → конверсії →
 * потік/воронка → плани й прогноз → дебіторка → операційне.
 */
export const METRICS: MetricDef[] = [
  // ───────────────────────── ГРОШІ (core/money.ts) ─────────────────────────
  { name: "received_money", source: "core.money.receivedMoney",
    desc: "Отримані кошти за період (етап 9 ⊎ 142, дедуп по угоді). Головна цифра виручки.",
    run: (s) => money.receivedMoney(s) },
  { name: "received_by_bucket", source: "core.money.receivedByBucket", granular: true,
    desc: "Отримані кошти по днях/тижнях/місяцях — для динаміки й «за рік по місяцях».",
    run: (s, a) => money.receivedByBucket(s, g(a)) },
  { name: "received_by_manager", source: "core.money.receivedByMgr",
    desc: "Отримані кошти в розрізі менеджерів.", run: (s) => money.receivedByMgr(s) },
  { name: "received_by_team", source: "core.money.receivedByTeam",
    desc: "Отримані кошти в розрізі команд.", run: (s) => money.receivedByTeam(s) },
  { name: "received_by_client", source: "core.money.receivedByClientKey",
    desc: "Отримані кошти в розрізі клієнтів (client_key) — для звіту по клієнту.",
    run: (s) => money.receivedByClientKey(s) },
  { name: "received_by_segment", source: "core.money.receivedBySegment",
    desc: "Виручка в розрізі нові / постійні / лідоген.", run: (s) => money.receivedBySegment(s) },
  { name: "received_by_channel", source: "core.money.receivedByChannel",
    desc: "Виручка в розрізі каналів реклама / лідоген.",
    run: (s, _a, src) => money.receivedByChannel(s, src) },
  { name: "success_money", source: "core.money.successMoney",
    desc: "Лише успішні угоди (142) за датою закриття — знаменник avg_check_success_only.",
    run: (s) => money.successMoney(s) },
  { name: "success_by_bucket", source: "core.money.successByBucket", granular: true,
    desc: "Успішні угоди (142) по днях/тижнях/місяцях. «Відправлені авто» = deals цієї метрики.",
    run: (s, a) => money.successByBucket(s, g(a)) },
  { name: "paid_only_money", source: "core.money.paidOnlyMoney",
    desc: "Оплачені, але ще не переведені в 142 (етап 9 без 142). received = success ⊎ paidOnly.",
    run: (s) => money.paidOnlyMoney(s) },
  { name: "expected_money", source: "core.money.expectedMoney",
    desc: "Очікування оплат — етап 8 за датою входу. НЕ «Виставлення рахунку».",
    run: (s) => money.expectedMoney(s) },
  { name: "awaiting_now_snapshot", source: "core.money.awaitingNowSnapshot",
    desc: "ЗНІМОК «станом на зараз»: угоди, що ЗАРАЗ на етапах 8+9. НІКОЛИ не сумувати у виручку періоду.",
    run: (s) => money.awaitingNowSnapshot(s) },

  // ───────────────────────── СЕРЕДНІЙ ЧЕК ─────────────────────────
  { name: "avg_check_by_manager", source: "core.money.avgCheckByManager",
    desc: "Середній чек по менеджерах (фактичний і очікуваний окремо — складати заборонено).",
    run: (s) => money.avgCheckByManager(s) },

  // ───────────────────────── КОНВЕРСІЇ ─────────────────────────
  { name: "conversion_ads_by_month", source: "core.metrics.conversionAdsByMonth",
    desc: "Конверсія РЕКЛАМИ помісячно (знаменник adDealSql, чисельник — дійшли до MONEY_ZONE). Дає cohortPct і periodPct + mature.",
    run: (s, _a, src) => metrics.conversionAdsByMonth(s, src) },
  { name: "conversion_ads_by_manager", source: "core.metrics.conversionAdsByManager",
    desc: "Конверсія реклами по менеджерах за період.",
    run: (s, _a, src) => metrics.conversionAdsByManager(s, src) },
  { name: "conversion_ads_by_team", source: "core.metrics.conversionAdsByTeam",
    desc: "Конверсія реклами по командах (Σ менеджерів = команда за побудовою).",
    run: (s, _a, src) => metrics.conversionAdsByTeam(s, src) },
  { name: "conversion_leadgen_by_manager", source: "core.metrics.conversionLeadgenByManager",
    desc: "Конверсія ЛІДОГЕНУ по менеджерах (знаменник — FC-угоди з каналом lead_channel='leadgen', створені в періоді; НЕ реєстр бота).",
    run: (s) => metrics.conversionLeadgenByManager(s) },
  { name: "conversion_prodzvin_by_month", source: "core.metrics.conversionProdzvinByMonth",
    desc: "Конверсія воронки Продзвін помісячно.", run: (s) => metrics.conversionProdzvinByMonth(s) },
  { name: "conversion_reactivation_by_month", source: "core.metrics.conversionReactivationByMonth",
    desc: "Конверсія воронки Реактивація помісячно.", run: (s) => metrics.conversionReactivationByMonth(s) },

  // ───────────────────────── ПОТІК / ВОРОНКА ─────────────────────────
  { name: "created_by_bucket", source: "core.metrics.createdByBucket", granular: true,
    desc: "Створено угод повного циклу по днях/тижнях/місяцях (за датою створення).",
    run: (s, a) => metrics.createdByBucket(s, g(a)) },
  { name: "leads_taken_by_bucket", source: "core.metrics.leadsTakenByBucket", granular: true,
    desc: "Взято лідів у роботу по бакетах (єдиний анкер), зі сплітом по каналах.",
    run: (s, a) => metrics.leadsTakenByBucket(s, g(a), true) },
  { name: "ads_accepted", source: "core.metrics.adsAccepted",
    desc: "«Прийнято реклами» за період — знаменник conversion_ads.",
    run: (s, _a, src) => metrics.adsAccepted(s, src) },
  { name: "segments", source: "core.metrics.segments",
    desc: "Розклад угод періоду на лідоген / постійні / нові (інваріант: сума = загал).",
    run: (s) => metrics.segments(s) },
  { name: "funnel_by_stage", source: "core.metrics.funnelByStage",
    desc: "Скільки угод на кожному етапі воронки повного циклу.", run: (s) => metrics.funnelByStage(s) },
  { name: "dispatched_by_manager", source: "core.metrics.dispatchedByManager",
    desc: "Поставлені машини по менеджерах + виручка і спліт по каналах.",
    run: (s) => metrics.dispatchedByManager(s) },
  { name: "new_repeat_totals", source: "core.metrics.newRepeatTotals",
    desc: "Підсумки по нових і постійних клієнтах за період.", run: (s) => metrics.newRepeatTotals(s) },
  { name: "lost_deals", source: "core.metrics.lostDeals",
    desc: "Втрачені угоди (143) за період: кількість і сума.", run: (s) => metrics.lostDeals(s) },

  // ───────────────────────── ПЛАНИ Й ПРОГНОЗ ─────────────────────────
  { name: "manager_plan", source: "core.plans.managerPlan",
    desc: "План виручки по менеджерах на місяць (period = місяць плану).",
    run: (s) => plans.managerPlan({ teamId: s.teamId ?? null, month: planMonth(s) }) },
  { name: "projection", source: "core.metrics.buildProjection",
    desc: "Прогноз місяця «станом на зараз»: факт + зона визнання + добір.",
    run: (s) => metrics.buildProjection(s) },
  { name: "repeat_forecast_by_manager", source: "core.metrics.repeatForecastByManager",
    desc: "Прогноз виручки від ПОСТІЙНИХ клієнтів по менеджерах.",
    run: (s) => metrics.repeatForecastByManager(s) },
  { name: "carryover_by_manager", source: "core.metrics.carryoverByManager",
    desc: "Перенесені угоди по менеджерах на початок місяця (потрібен from = початок місяця).",
    run: (s) => metrics.carryoverByManager(snap(s), planMonth(s)) },

  // ───────────────────────── ДЕБІТОРКА ─────────────────────────
  { name: "receivables_total", source: "core.metrics.receivablesTotal",
    desc: "Загальна дебіторка (повна сума, включно з неатрибутованим боргом).",
    run: (s) => metrics.receivablesTotal(snap(s)) },
  { name: "receivables_by_manager", source: "core.metrics.receivablesByManager",
    desc: "Дебіторка по менеджерах («Без менеджера» окремим рядком).",
    run: (s) => metrics.receivablesByManager(snap(s)) },
  { name: "receivables_aging", source: "core.metrics.receivablesAging",
    desc: "Дебіторка за строками давності.", run: () => metrics.receivablesAging() },

  // ───────────────────────── ОПЕРАЦІЙНЕ ─────────────────────────
  { name: "stuck_deals_grouped", source: "core.metrics.stuckDealsGrouped",
    desc: "Застряглі угоди, згруповано (без людської активності понад поріг).",
    run: (s) => metrics.stuckDealsGrouped(snap(s)) },
  { name: "avg_deal_cycle_days", source: "core.metrics.avgDealCycleDays",
    desc: "Середній цикл угоди в днях.", run: (s) => metrics.avgDealCycleDays(s) },
  { name: "response_time", source: "core.metrics.responseTime",
    desc: "Час першої реакції на лід.", run: (s) => metrics.responseTime(s) },
];

const BY_NAME = new Map(METRICS.map((m) => [m.name, m]));

/** Компактний каталог для опису інструмента (модель має знати імена). */
export function metricCatalog(): string {
  return METRICS.map((m) => `${m.name} — ${m.desc}`).join("\n");
}

export type MetricResult =
  | { ok: true; metric: string; source: string; scope: Record<string, unknown>;
      /** Розв'язаний період словами — модель ЗОБОВ'ЯЗАНА назвати його у відповіді. */
      resolvedPeriod: string | null;
      /** Поточний місяць ще не завершився / код виправив період — сказати вголос. */
      periodNote?: string;
      table: string; data: unknown }
  | { ok: false; error: string };

/** Ліміт рядків у `table` — щоб великі зрізи (клієнти) не рвали контекст. */
const TABLE_ROW_CAP = 200;

const cell = (v: unknown): string =>
  v == null ? "—"
    : typeof v === "number" ? String(v)
      : typeof v === "object" ? JSON.stringify(v)
        : String(v);

/**
 * ДЕТЕРМІНОВАНА ПОДАЧА. Формат таблиці будує КОД, а не модель.
 *
 * Навіщо: замір показав, що навіть коли цифри правильні й збігаються з ядром, дві
 * відповіді на те саме питання виглядають по-різному — одна друкує revenue поруч із
 * deals, інша ні; одна пише «2025-08», інша «серп.25». Цифри ті самі, але звірити
 * дві такі відповіді між собою (чи з учорашньою) вже неможливо. Проханням у промті
 * це не лікується — лікується тим, що подачу складає код.
 *
 * Обрізання ВИДИМЕ: модель має бачити, що рядків більше, ніж показано, інакше вона
 * порахує по огризку і подасть це як повну картину.
 */
function renderTable(data: unknown): string {
  if (Array.isArray(data)) {
    if (!data.length) return "(порожньо)";
    const rows = data.slice(0, TABLE_ROW_CAP) as Record<string, unknown>[];
    const keys: string[] = [];
    for (const r of rows) if (r && typeof r === "object") for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    const out = [keys.join(" | "), ...rows.map((r) => keys.map((k) => cell(r?.[k])).join(" | "))];
    if (data.length > TABLE_ROW_CAP) out.push(`…показано ${TABLE_ROW_CAP} з ${data.length} рядків`);
    return out.join("\n");
  }
  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => `${k}: ${cell(v)}`).join("\n");
  }
  return cell(data);
}

/**
 * Резолв імені менеджера/команди в id. Повертає підказку зі списком кандидатів при
 * неоднозначності — щоб модель виправилась за ОДИН виток, а не пішла шукати схему.
 */
async function resolveScope(a: MetricArgs, period: ResolvedPeriod | null): Promise<ResolvedScope | { error: string }> {
  const s: ResolvedScope = period
    ? { from: period.from, to: period.to }
    : { from: a.from ?? null, to: a.to ?? null };
  if (a.manager) {
    const r = await pool.query<{ id: number; name: string }>(
      "SELECT id, name FROM managers WHERE is_active AND name ILIKE $1 ORDER BY name", [`%${a.manager}%`]);
    if (r.rows.length === 0) return { error: `Менеджера «${a.manager}» не знайдено серед активних.` };
    if (r.rows.length > 1) return { error: `Неоднозначно «${a.manager}». Кандидати: ${r.rows.map((x) => x.name).join(" · ")}` };
    s.managerId = r.rows[0].id;
  }
  if (a.team) {
    const r = await pool.query<{ id: number; name: string }>(
      "SELECT id, name FROM teams WHERE name ILIKE $1 ORDER BY name", [`%${a.team}%`]);
    if (r.rows.length === 0) return { error: `Команду «${a.team}» не знайдено.` };
    if (r.rows.length > 1) return { error: `Неоднозначно «${a.team}». Кандидати: ${r.rows.map((x) => x.name).join(" · ")}` };
    s.teamId = r.rows[0].id;
  }
  return s;
}

/**
 * Єдина точка виклику. Ніякого SQL — тільки диспетч у ядро. Помилка повертається
 * тегованим значенням (як `runReadOnly`), а не винятком.
 */
export async function getMetric(name: string, a: MetricArgs): Promise<MetricResult> {
  const def = BY_NAME.get(name);
  if (!def) {
    return { ok: false, error: `Невідома метрика «${name}». Доступні: ${METRICS.map((m) => m.name).join(", ")}` };
  }
  // 🗓 ПЕРІОД ВИРІШУЄ КОД. Пріоритет: явний `month` (місяць без року) → страхувальна
  // сітка на майбутній період → те, що передала модель у from/to.
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const period = (a.month ? resolveNamedMonth(a.month, today) : null)
    ?? guardFuturePeriod(a.from, a.to, today);
  const scope = await resolveScope(a, period);
  if ("error" in scope) return { ok: false, error: scope.error };
  try {
    const { adSources } = await getSettings();
    const data = await def.run(scope, a, adSources);
    return {
      ok: true, metric: def.name, source: def.source,
      scope: { from: scope.from, to: scope.to, managerId: scope.managerId ?? null, teamId: scope.teamId ?? null,
               granularity: def.granular ? g(a) : undefined },
      resolvedPeriod: period?.label ?? (scope.from && scope.to ? `${scope.from} … ${scope.to}` : null),
      periodNote: period?.correction
        ?? (period?.incomplete ? "поточний місяць ще НЕ завершився — цифри неповні, сказати це користувачу" : undefined),
      table: renderTable(data),
      data,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
