// Обчислення auto-метрик відділів leadgen/marketing/logistics із CRM (наша БД,
// БЕЗ звернень до Kommo). Дзеркалить перевірені предикати з routes/dashboard.ts.
// 01.09.2026 сюди ж додано finance.receivables — але ОКРЕМОЮ функцією
// (`computeFinanceSnapshot`), бо це ЗНІМОК, а не період: у `computeDeptAuto`
// він не поміщається ні за семантикою, ні за білим списком.
// Використовується і бекфілом, і живим перерахунком. Усі метрики — рівня ВІДДІЛУ
// (team_lead = NULL). Повертає Map<`${dept}|${ptype}|${period_start}|${metric}`→value>.
//
// Увімкнені лише ті, що пройшли звірку з листом (scripts/reconcileDeptAuto.ts).
// Снапшот-метрики (repeat_clients_active, lg_count) рахуються лише для поточного
// періоду окремо (тут не даємо — історію не відтворити).

import { pool } from "../db/pool.js";
import { getSettings } from "../routes/settings.js";
// КРОК 9 Фаза 3: `adDealSql` — єдине джерело `core/metrics.ts` (прибрано локальний дубль).
// КРОК Г #1: нецільові — теж із ядра (nonTargetLeadsByBucket), спільний предикат із /lead-quality.
import { adDealSql, nonTargetLeadsByBucket, receivablesTotal, conversionCohortByBucket } from "../core/metrics.js";

const FULL_CYCLE = [8921932, 155304];

type Row = { bucket: string; v: string };
const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

// Увімкнені auto-метрики (пройшли звірку з листом, avg |Δ%| ≤ ~11%, scripts/
// reconcileDeptAuto.ts). Ключ `${dept}|${metric}`. Решта (ad_leads 30% —
// різне визначення; канальні lg_*/ad_paid — ще не звірені) лишаються imported.
export const DEPT_AUTO_ENABLED = new Set([
  "marketing|non_target_leads",
  "marketing|ad_budget_total",
  "logistics|machines_dispatched_total",
  "logistics|repeat_machines",
  "logistics|repeat_revenue",
]);

/**
 * @param since  ISO date — рахуємо лише бакети з period_start >= since.
 */
export async function computeDeptAuto(since: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { adSources } = await getSettings();
  const set = (dept: string, pt: string, ps: string, metric: string, v: number) => {
    if (ps < since) return;
    if (!DEPT_AUTO_ENABLED.has(`${dept}|${metric}`)) return; // лише звірені
    out.set(`${dept}|${pt}|${ps}|${metric}`, v);
  };

  for (const [ptype, trunc] of [["month", "month"], ["week", "week"]] as const) {
    // ── marketing.ad_leads (full-cycle adDealSql, за створенням) ──
    const adLeads = await pool.query<Row>(
      `SELECT to_char(date_trunc('${trunc}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket, COUNT(*) AS v
         FROM deals d
        WHERE d.pipeline_id = ANY($1) AND ${adDealSql("$2")} AND d.created_at_kommo IS NOT NULL
        GROUP BY bucket`, [FULL_CYCLE, adSources]);
    for (const r of adLeads.rows) set("marketing", ptype, r.bucket, "ad_leads", Number(r.v));

    // ── marketing.non_target_leads (КРОК Г #1: реклама ∩ reject_reason {Дубль|Перевізник},
    //    з ядра — спільний предикат із /lead-quality; стара Кваліфікація-143-усе знято) ──
    const nonTarget = await nonTargetLeadsByBucket(adSources, trunc);
    // 🕰 Бакети до горизонту reject_reason → count=null → НЕ пишемо (лишаємо imported,
    // не затираємо «—» нулем).
    for (const r of nonTarget) if (r.count != null) set("marketing", ptype, r.bucket, "non_target_leads", r.count);

    // ── marketing.ad_budget_total (ad_budget_daily.budget_fact) ──
    const adBudget = await pool.query<Row>(
      `SELECT to_char(date_trunc('${trunc}', day), 'YYYY-MM-DD') AS bucket, COALESCE(SUM(budget_fact),0) AS v
         FROM ad_budget_daily GROUP BY bucket`);
    for (const r of adBudget.rows) set("marketing", ptype, r.bucket, "ad_budget_total", Number(r.v));

    // ── logistics.machines_dispatched_total — Правило №1: перейшли в успіх у періоді ──
    const dispTotal = await pool.query<Row>(
      `SELECT to_char(date_trunc('${trunc}', (d.closed_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket, COUNT(*) AS v
         FROM deals d
        WHERE d.pipeline_id = ANY($1) AND d.status_id = 142 AND d.closed_at_kommo IS NOT NULL
        GROUP BY bucket`, [FULL_CYCLE]);
    for (const r of dispTotal.rows) set("logistics", ptype, r.bucket, "machines_dispatched_total", Number(r.v));

    // ── logistics.repeat_revenue / repeat_machines (постійні: перша оплата ДО періоду) ──
    // «постійний» = клієнт, чия перша paid-угода була раніше за початок бакета.
    const repeat = await pool.query<{ bucket: string; rev: string; cnt: string }>(
      `WITH firsts AS (
         SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid
           FROM deals d
           JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
          WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
          GROUP BY d.client_key
       )
       SELECT to_char(date_trunc('${trunc}', (d.closed_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS cnt
         FROM deals d
         JOIN firsts f ON f.client_key = d.client_key
        WHERE d.pipeline_id = ANY($1) AND d.status_id = 142 AND d.closed_at_kommo IS NOT NULL
          AND f.first_paid < date_trunc('${trunc}', (d.closed_at_kommo ${KYIV}))
        GROUP BY bucket`, [FULL_CYCLE]);
    for (const r of repeat.rows) {
      set("logistics", ptype, r.bucket, "repeat_revenue", Number(r.rev));
      set("logistics", ptype, r.bucket, "repeat_machines", Number(r.cnt));
    }
  }
  return out;
}

/**
 * 💰 `finance.receivables` — ЄДИНИЙ ПИСАР (01.09.2026, рішення власника).
 *
 * Показник стояв у каталозі як `auto`, писаря не мав, і руками його заповнити
 * теж не можна: `PUT /api/statistics/manual` відхиляє все, чиє джерело не
 * `manual`. Тобто цифру не можна було ні порахувати, ні ввести — вона стояла
 * замороженим імпортом на 2026-06 при живій дебіторці в базі.
 *
 * 🔴 ЦЕ ЗНІМОК, А НЕ ПЕРІОД — І ЦЕ НЕ ВИБІР, А ПРИРОДА ДАНИХ.
 * `receivables` `TRUNCATE`-иться синком кожні 15 хв і має лише `synced_at`;
 * історії боргу в базі НЕМАЄ. Порахувати «дебіторку за червень» ретроспективно
 * нема з чого. Тому пишемо рівно те, що можна стверджувати чесно: **борг станом
 * на останній знімок УСЕРЕДИНІ бакета**. Для закритого місяця це його останній
 * запис перед північчю, тобто «на кінець періоду»; для поточного — «зараз».
 * Підпис у каталозі це називає (`label`), інакше знімок читався б як період —
 * рівно та хиба, що вже живе в `payment_received`/`invoiced_amount`/
 * `managers_count`, які підписані періодними, а рахуються без фільтра дати.
 *
 * 🔴 ЗАКРИТІ ПЕРІОДИ НЕ ЧІПАЮТЬСЯ. Функція віддає рівно два записи — за
 * переданими анкерами ПОТОЧНОГО місяця й тижня, і жодного іншого `period_start`.
 * Це не акуратність, а захист: писар із вікном «останні 40 днів» вписав би
 * СЬОГОДНІШНІЙ борг у минулі бакети й мовчки переписав історію. Стереже `#24w`.
 *
 * 🧮 ЧИСЛО БЕРЕТЬСЯ З ЯДРА (`metrics.receivablesTotal`), а не власним SQL:
 * своя копія означення зійшлася б із копією, а не з правилом, і розійшлася б із
 * екраном Дебіторки через місяці. Стереже `#24v` — саботаж по ядру червонить.
 *
 * ⚠️ У `DEPT_AUTO_ENABLED` НЕ вноситься свідомо: той білий список означає
 * «періодні метрики, звірені з Google-листом», а тут ні періоду, ні листа.
 *
 * @param curMonth `YYYY-MM-DD` — початок ПОТОЧНОГО місяця (київський).
 * @param curWeek  `YYYY-MM-DD` — початок ПОТОЧНОГО тижня (київський).
 */
export async function computeFinanceSnapshot(
  curMonth: string, curWeek: string,
): Promise<Map<string, number>> {
  const total = await receivablesTotal({});
  return new Map<string, number>([
    [`finance|month|${curMonth}|receivables`, total],
    [`finance|week|${curWeek}|receivables`, total],
  ]);
}

/**
 * 🎯 ДВІ КОГОРТНІ КОНВЕРСІЇ У «СТАТИСТИКАХ» (01.09.2026, рішення власника).
 *
 *   `conversion_new_crm`     — по НОВИХ клієнтах (сегмент `new` за `segmentCase`);
 *   `conversion_leadgen_crm` — по ЛІДОГЕНЕРАТОРАХ (`lead_channel = 'leadgen'`).
 *
 * 🔴 ТУТ НЕМАЄ ЖОДНОГО SQL, І ЦЕ НАВМИСНО. Усе означення — знаменник, чисельник,
 * анкер, поріг — живе в `core/metrics.conversionCohortByBucket`. Своя копія
 * зійшлася б із копією, а не з правилом, і розійшлася б із Оглядом через місяці.
 * Стереже `#24u`: він читає тіло цієї функції й червоніє на появі `pool.query`.
 *
 * 🔴 БАКЕТ НИЖЧЕ ПОРОГА НЕ ПИШЕТЬСЯ ВЗАГАЛІ. `pct === null` означає «замало
 * даних», і рядка бути не повинно — відсутність екран малює «—». Записати нуль
 * означало б стверджувати «конверсія нульова», тобто вигадати вимір. Стереже
 * `#24t` з обох боків межі: 9 → «—», 10 → число.
 *
 * ⚠️ Ці метрики НЕ вносяться в `DEPT_AUTO_ENABLED`: той білий список означає
 * «звірені з Google-листом», а рішення власника прямо каже — «по лідгенах не
 * рівняємось на таблицю», нова метрика свідомо інша.
 */
export async function computeCohortConversions(since: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const metricOf = { new: "conversion_new_crm", leadgen: "conversion_leadgen_crm" } as const;
  for (const kind of ["new", "leadgen"] as const) {
    for (const [ptype, trunc] of [["month", "month"], ["week", "week"]] as const) {
      for (const row of await conversionCohortByBucket(kind, trunc, since)) {
        if (row.pct == null) continue; // нижче порога — «—», а не нуль
        out.set(`marketing|${ptype}|${row.bucket}|${metricOf[kind]}`, row.pct);
      }
    }
  }
  return out;
}
