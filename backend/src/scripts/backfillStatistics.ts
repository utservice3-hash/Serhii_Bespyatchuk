// Одноразовий бекфіл розділу «Статистики». Запуск ВРУЧНУ (не в cron):
//   node dist/scripts/backfillStatistics.js
//
// Що робить (docs/STATISTICS_SPEC.md §0-БІС):
//  1. Імпортує історію з Google-таблиці для 6 відділів у statistics_values
//     (source='imported'), з нормалізацією чисел/дат, R1 (тиждень→понеділок),
//     R2 («самостійні»+«Шевчук»→«Шевчук Назар», sum-метрики сумуються).
//  2. Перераховує FLOW-метрики sales із CRM (revenue_won, machines_success,
//     cash_deals_amount, machines_dispatched) і ПЕРЕЗАПИСУЄ ними імпортовані
//     рядки як source='auto' (CRM — істина). Снапшот-метрики (оплата/рахунки/
//     дебіторка/к-ть) історично лишаються imported — їх веде живий перерахунок
//     (Крок 3) для поточних періодів.
//  3. Друкує звіт розбіжностей CRM vs лист (sales, помісячно) → консоль +
//     docs/STATISTICS_RECONCILIATION.md (файл пише вручну оператор із виводу).
//
// Аномалії (§6 спеки): fin-М 01.12.2025 (не на місці) — WARN+skip; биті дати
// (рік 0206, слеші, без нулів) — нормалізуємо або WARN+skip; числа з U+00A0/комою.

import { pool } from "../db/pool.js";
import { parseCsv } from "../utils/csv.js";
import { CATALOG, canonTeamLead, SALES_TEAM_LEAD, SALES_FALLBACK_LEAD, STATS_AUTO_FROM, SALES_AUTO_METRICS } from "../statistics/catalog.js";
import { computeDeptAuto } from "../statistics/computeAuto.js";

const FULL_CYCLE = [8921932, 155304];
const SALES_TEAM_IDS = Object.keys(SALES_TEAM_LEAD).map(Number); // 5,6,13,14,15,4
const CASH_SQL = "d.payment_type ILIKE '%нал%' AND d.payment_type NOT ILIKE '%безнал%'";

let warnings = 0;
const warn = (m: string) => { warnings++; console.warn("  ⚠️ " + m); };

// ── Нормалізатори ────────────────────────────────────────────────────────────
function normNum(raw?: string): number | null {
  let s = (raw ?? "").replace(/ /g, "").replace(/\s/g, "").trim();
  if (s === "" || s === "-") return null;
  const pct = s.includes("%");
  s = s.replace(/%/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n; // percent зберігаємо часткою (0.0532), UI домножить
}

/** Парсить дату листа → ISO 'YYYY-MM-DD' або null (з WARN). */
function parseSheetDate(raw: string, dept: string, ptype: string, prevRaw: string): string | null {
  const t = (raw ?? "").trim().replace(/\//g, ".");
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) { warn(`${dept}/${ptype}: нерозпізнана дата «${raw}» — пропуск`); return null; }
  let [, dd, mm, yyyy] = m;
  const y = Number(yyyy), mo = Number(mm), d = Number(dd);
  if (y < 2023 || y > 2027) { warn(`${dept}/${ptype}: підозрілий рік у «${raw}» — пропуск (A3)`); return null; }
  // A1: fin-М 01.12.2025 не на місці (має бути 2024) — після рядка 2024.
  if (dept === "finance" && ptype === "month" && d === 1 && mo === 12 && y === 2025 && /\.2024$/.test(prevRaw)) {
    warn(`finance/month: рядок «${raw}» не на місці (ймовірно 01.12.2024) — пропуск (A1)`);
    return null;
  }
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return iso;
}

/** R1: тиждень у листі = неділя (останній день) → period_start = понеділок = −6 днів. */
function toPeriodStart(iso: string, ptype: string): string {
  if (ptype === "month") return iso; // вже 1-ше число
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 6);
  return dt.toISOString().slice(0, 10);
}

async function fetchTab(url: string): Promise<string[][]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch ${res.status}: ${url}`);
  return parseCsv(await res.text());
}
const STATS_SHEET_ID = "1F_lTE7a--BYuLf1A4VsnZkI1n_fsZ94d-s1neK5ygro";
function tabUrl(name: string): string {
  return `https://docs.google.com/spreadsheets/d/${STATS_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
}

// ── Акумулятор (для R2-злиття перед вставкою) ────────────────────────────────
// ключ: dept|ptype|period_start|team_lead|metric → { value, agg }
type Acc = Map<string, { value: number; agg: string }>;
const K = (dept: string, pt: string, ps: string, lead: string | null, metric: string) =>
  `${dept}|${pt}|${ps}|${lead ?? ""}|${metric}`;

function put(acc: Acc, dept: string, pt: string, ps: string, lead: string | null, metric: string, agg: string, val: number | null) {
  if (val === null) return;
  const k = K(dept, pt, ps, lead, metric);
  const cur = acc.get(k);
  if (!cur) { acc.set(k, { value: val, agg }); return; }
  if (agg === "sum") cur.value += val;
  else cur.value = val; // last/avg: останнє значення виграє (при merge Шевчук)
}

// ── Фаза 1: імпорт історії з листа ───────────────────────────────────────────
async function importSheets(acc: Acc, sheetSnapshot: Map<string, number>) {
  for (const dept of CATALOG) {
    for (const ptype of ["month", "week"] as const) {
      const tab = ptype === "month" ? dept.tabMonth : dept.tabWeek;
      let rows: string[][];
      try { rows = await fetchTab(tabUrl(tab)); }
      catch (e) { warn(`${tab}: ${(e as Error).message}`); continue; }
      if (rows.length <= 1) { warn(`${tab}: порожньо`); continue; }

      let prevRaw = "";
      let imported = 0;
      for (const r of rows.slice(1)) {
        const rawDate = (r[dept.csvDateIndex] ?? "").trim();
        if (!rawDate) { prevRaw = rawDate; continue; }
        const iso = parseSheetDate(rawDate, dept.key, ptype, prevRaw);
        prevRaw = rawDate;
        if (!iso) continue;
        const ps = toPeriodStart(iso, ptype);

        // sales: розріз по тімліду (кол.1), R2-канон
        const lead = dept.hasTeamLeadBreakdown ? canonTeamLead((r[1] ?? "").trim()) : null;
        if (dept.hasTeamLeadBreakdown && !lead) continue;

        for (const met of dept.metrics) {
          if (met.source === "derived") continue; // derived не зберігаємо
          const idx = ptype === "month" ? met.csvIndexMonth : met.csvIndexWeek;
          if (idx === undefined) continue;
          const val = normNum(r[idx]);
          put(acc, dept.key, ptype, ps, lead, met.key, met.aggregation, val);
          // знімок листа для звірки (лише sales, department-total)
          if (dept.key === "sales" && ptype === "month") {
            const sk = `${ps}|${met.key}`;
            if (met.aggregation === "sum") sheetSnapshot.set(sk, (sheetSnapshot.get(sk) ?? 0) + (val ?? 0));
          }
        }
        imported++;
      }
      console.log(`  імпорт ${tab}: ${imported} рядків`);
    }
  }
}

// ── Фаза 2: перерахунок FLOW-метрик sales із CRM ─────────────────────────────
// Повертає Map<`${ps}|${lead}|${metric}` → value> для month і week.
async function computeSalesAuto(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const teamLeadOf = (teamId: number | null) =>
    teamId != null && SALES_TEAM_LEAD[teamId] ? canonTeamLead(SALES_TEAM_LEAD[teamId]) : SALES_FALLBACK_LEAD;

  for (const [ptype, trunc] of [["month", "month"], ["week", "week"]] as const) {
    // Q1: closed-based (revenue_won, machines_success, cash) — 142, закриті в періоді
    const q1 = await pool.query<{ team_id: number | null; bucket: string; rev: string; succ: string; cash: string }>(
      `SELECT m.team_id AS team_id,
              to_char(date_trunc('${trunc}', (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS succ,
              COALESCE(SUM(d.price) FILTER (WHERE ${CASH_SQL}),0) AS cash
         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
        WHERE d.pipeline_id = ANY($1) AND d.status_id = 142 AND d.closed_at_kommo IS NOT NULL
          AND (m.team_id IS NULL OR m.team_id = ANY($2))
        GROUP BY m.team_id, bucket`,
      [FULL_CYCLE, SALES_TEAM_IDS]
    );
    for (const row of q1.rows) {
      const lead = teamLeadOf(row.team_id);
      const ps = row.bucket;
      const add = (metric: string, v: number) => {
        const k = `${ptype}|${ps}|${lead}|${metric}`;
        out.set(k, (out.get(k) ?? 0) + v);
      };
      add("revenue_won", Number(row.rev));
      add("machines_success", Number(row.succ));
      add("cash_deals_amount", Number(row.cash));
    }
    // Правило №1: machines_dispatched = machines_success (якір «успіх»).
    for (const row of q1.rows) {
      const lead = teamLeadOf(row.team_id);
      const k = `${ptype}|${row.bucket}|${lead}|machines_dispatched`;
      out.set(k, (out.get(k) ?? 0) + Number(row.succ));
    }
  }
  return out;
}

// ── Запис ────────────────────────────────────────────────────────────────────
async function flushAcc(acc: Acc) {
  const rows = [...acc.entries()];
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const batch = rows.slice(i, i + CH);
    const vals: unknown[] = [];
    const tuples = batch.map(([k, v], j) => {
      const [dept, pt, ps, lead, metric] = k.split("|");
      const b = j * 6;
      vals.push(dept, pt, ps, lead === "" ? null : lead, metric, v.value);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},'imported')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
      vals
    );
  }
}

async function flushSalesAuto(auto: Map<string, number>) {
  // Пишемо auto ЛИШЕ де CRM надійний: period_start >= STATS_AUTO_FROM і метрика
  // з SALES_AUTO_METRICS. Старіша історія та cash_deals_amount лишаються imported.
  const rows = [...auto.entries()].filter(([k]) => {
    const [, ps, , metric] = k.split("|");
    return ps >= STATS_AUTO_FROM && SALES_AUTO_METRICS.includes(metric);
  });
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const batch = rows.slice(i, i + CH);
    const vals: unknown[] = [];
    const tuples = batch.map(([k, value], j) => {
      const [pt, ps, lead, metric] = k.split("|");
      const b = j * 5;
      vals.push(pt, ps, lead, metric, value);
      return `('sales',$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'auto')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      vals
    );
  }
}

async function flushDeptAuto(dept: Map<string, number>) {
  const rows = [...dept.entries()];
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const batch = rows.slice(i, i + CH);
    const vals: unknown[] = [];
    const tuples = batch.map(([k, value], j) => {
      const [department, pt, ps, metric] = k.split("|");
      const b = j * 5;
      vals.push(department, pt, ps, metric, value);
      return `($${b + 1},$${b + 2},$${b + 3},NULL,$${b + 4},$${b + 5},'auto')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      vals
    );
  }
}

// ── Звіт розбіжностей (sales, помісячно, department-total) ────────────────────
async function reconcile(sheetSnapshot: Map<string, number>, auto: Map<string, number>) {
  // CRM department-total per month = сума по лідах з auto-мапи
  const crm = new Map<string, number>(); // `${ps}|${metric}`
  for (const [k, v] of auto) {
    const [pt, ps, , metric] = k.split("|");
    if (pt !== "month") continue;
    const sk = `${ps}|${metric}`;
    crm.set(sk, (crm.get(sk) ?? 0) + v);
  }
  const months = [...new Set([...sheetSnapshot.keys(), ...crm.keys()].map((k) => k.split("|")[0]))].sort();
  const metrics = ["revenue_won", "machines_success", "cash_deals_amount"];
  const lines: string[] = [];
  lines.push("| Місяць | Метрика | CRM (auto) | Лист | Δ | Δ% |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const mo of months) {
    for (const met of metrics) {
      const c = crm.get(`${mo}|${met}`) ?? 0;
      const s = sheetSnapshot.get(`${mo}|${met}`) ?? 0;
      if (c === 0 && s === 0) continue;
      const delta = c - s;
      const pct = s !== 0 ? (delta / s) * 100 : (c !== 0 ? 100 : 0);
      lines.push(`| ${mo} | ${met} | ${Math.round(c).toLocaleString("uk-UA")} | ${Math.round(s).toLocaleString("uk-UA")} | ${Math.round(delta).toLocaleString("uk-UA")} | ${pct.toFixed(1)}% |`);
    }
  }
  console.log("\n=== ЗВІТ РОЗБІЖНОСТЕЙ (sales, CRM vs лист, помісячно) ===\n" + lines.join("\n"));
  return lines.join("\n");
}

async function main() {
  // Бекфіл — повна перебудова історії, тож чистимо таблицю (ручних значень ще
  // немає — розділ не в проді). Живий перерахунок (Крок 3) далі UPSERT-ить
  // поточні періоди, ручний ввід (Крок 3, API) з'явиться пізніше.
  console.log("→ Фаза 0: TRUNCATE statistics_values (чиста перебудова)");
  await pool.query("TRUNCATE statistics_values");

  console.log("→ Фаза 1: імпорт історії з листа");
  const acc: Acc = new Map();
  const sheetSnapshot = new Map<string, number>();
  await importSheets(acc, sheetSnapshot);
  console.log(`  зібрано ${acc.size} значень (imported)`);

  console.log("→ Фаза 2: перерахунок FLOW-метрик sales із CRM");
  const auto = await computeSalesAuto();
  console.log(`  обчислено ${auto.size} auto-значень sales`);

  console.log("→ Фаза 2b: dept auto (marketing/logistics) із CRM");
  const deptAuto = await computeDeptAuto(STATS_AUTO_FROM);
  console.log(`  обчислено ${deptAuto.size} dept auto-значень`);

  console.log("→ Запис у statistics_values");
  await flushAcc(acc);
  await flushSalesAuto(auto);
  await flushDeptAuto(deptAuto);
  const total = await pool.query<{ n: string }>(`SELECT COUNT(*) n FROM statistics_values`);
  console.log(`  усього рядків у statistics_values: ${total.rows[0].n}`);

  console.log("→ Фаза 3: звірка");
  await reconcile(sheetSnapshot, auto);

  console.log(`\n✅ Бекфіл завершено. WARN: ${warnings}.`);
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err); process.exit(1); });
