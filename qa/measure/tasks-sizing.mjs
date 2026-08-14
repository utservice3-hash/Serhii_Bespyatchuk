/**
 * ЗАМІРИ ПЕРЕД ОПТИМІЗАЦІЄЮ СИНКУ ЗАДАЧ (#76 → прохід 2).
 *
 * READ-ONLY. Нічого не пише ні в БД, ні в Kommo. Не рухає вотермарк.
 * Запускати НА ПРОД-СЕРВЕРІ (там лежить `.env`), не в контейнері асистента:
 *
 *   cd /home/evraziat/uts.ua/dashboard/backend && set -a && . ./.env && set +a \
 *     && node ../qa/measure/tasks-sizing.mjs --step=all
 *
 * Друкує ЛИШЕ агреговані числа — жодного тексту задач, жодних персональних даних.
 *
 * ⚠️ ГАНЯТИ ПОЗА ВІКНОМ СИНКУ. Кроки volume/funnel/dry читають Kommo сотнями
 * запитів; поруч із `syncKommo` це шлях у 429 (і в IP-бан 08.07, який ми вже мали).
 * Розклад задачних джоб — 20,50; синк Kommo — щопівгодини. Вікно ~:05.
 *
 * Кроки (--step=): probe | volume | funnel | nulls | dry | size | all
 */

import { readFileSync } from "node:fs";

const BASE = process.env.KOMMO_BASE_URL;
const TOKEN = process.env.KOMMO_API_TOKEN;
const DB = process.env.DATABASE_URL;
if (!BASE || !TOKEN) throw new Error("Немає KOMMO_BASE_URL / KOMMO_API_TOKEN — джерело лише .env на сервері.");

const FC = "(8921932, 155304)"; // воронка «Перевозки повний цикл»: New + старий (core/money.ts FC_PIPELINES)

/**
 * 🔴 «АКТИВНА FC-УГОДА» — ТІЄЮ САМОЮ ФОРМОЮ, ЩО В КРИТЕРІЇ, а не своєю.
 * Критерій означує скоуп через `callTargetConds()` (core/stuckRule.ts): join з
 * `pipeline_stage_map` і `psm.funnel_stage <> 'paid'`. Спокусливий `status_id NOT
 * IN (142,143)` — ІНША вибірка: він відкидає лише виграно/втрачено, а «оплачено»
 * може стояти й на інших стадіях. Заміряти скоуп, відмінний від того, який потім
 * рахує критерій, — це і є «A = B ✓» навиворіт: числа зійдуться самі з собою й
 * розійдуться з продом. П'ята копія предикату тут не з'явиться.
 */
const ACTIVE_FC_JOIN = `JOIN pipeline_stage_map psm
      ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id`;
const ACTIVE_FC_WHERE = `d.pipeline_id IN ${FC} AND psm.funnel_stage <> 'paid'`;

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const STEP = arg("step", "all");
const want = (s) => STEP === "all" || STEP === s;

// ── Kommo: той самий тротл і ті самі заголовки, що в проді (7 req/s — жорстка стеля) ──
let lastCall = 0;
let calls = 0;
async function kommo(path) {
  const gap = 150 - (Date.now() - lastCall);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastCall = Date.now();
  calls += 1;
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (res.status === 204) return {};
  if (res.status === 429) throw new Error(`429 на ${path} — впёрлись у ліміт, зупиняюсь (calls=${calls})`);
  if (!res.ok) return { __status: res.status, __body: (await res.text()).slice(0, 300) };
  return res.json();
}

async function pg(sql, params = []) {
  if (!DB) throw new Error("Немає DATABASE_URL — крок потребує прод-БД.");
  const { default: pgmod } = await import("pg");
  const c = new pgmod.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const out = {};
const say = (k, v) => {
  out[k] = v;
  console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 1. ПРОБА filter[entity_id] — чи Kommo його ШАНУЄ, а не «чи вернув 200».
//
// 🔴 Перевіряємо ДІЄЮ: беремо реальну FC-угоду, просимо задачі ЛИШЕ по ній і
// дивимось на entity_id У ВІДПОВІДІ. Kommo вміє тихо ІГНОРУВАТИ невідомий
// фільтр і віддати все — тоді 200 нічого не доводить. Ознака ігнорування:
// у видачі є чужі entity_id.
// ─────────────────────────────────────────────────────────────────────────────
async function stepProbe() {
  const [row] = await pg(
    `SELECT d.kommo_id FROM deals d ${ACTIVE_FC_JOIN}
      WHERE ${ACTIVE_FC_WHERE}
      ORDER BY d.updated_at_kommo DESC NULLS LAST LIMIT 1`
  );
  if (!row) return say("probe", "НЕМА активної FC-угоди — крок неможливий");
  const id = String(row.kommo_id);
  const enc = encodeURIComponent;

  const one = await kommo(`/api/v4/tasks?limit=250&${enc("filter[entity_id]")}=${id}`);
  const oneTasks = one?._embedded?.tasks ?? [];
  const foreign = oneTasks.filter((t) => String(t.entity_id) !== id).length;

  // Список ID: вирішує, чи вибірка — N запитів, чи N/batch.
  const [row2] = await pg(
    `SELECT d.kommo_id FROM deals d ${ACTIVE_FC_JOIN}
      WHERE ${ACTIVE_FC_WHERE} AND d.kommo_id <> $1
      ORDER BY d.updated_at_kommo DESC NULLS LAST LIMIT 1`,
    [row.kommo_id]
  );
  const many = row2
    ? await kommo(`/api/v4/tasks?limit=250&${enc("filter[entity_id][]")}=${id}&${enc("filter[entity_id][]")}=${row2.kommo_id}`)
    : null;
  const manyTasks = many?._embedded?.tasks ?? [];
  const manyIds = new Set(manyTasks.map((t) => String(t.entity_id)));

  // Чи живе разом із вікном по updated_at (інкремент без вікна нам не підходить).
  const combo = await kommo(
    `/api/v4/tasks?limit=250&${enc("filter[entity_id]")}=${id}` +
      `&${enc("filter[updated_at][from]")}=${now - 180 * DAY}&${enc("filter[updated_at][to]")}=${now}`
  );
  const comboTasks = combo?._embedded?.tasks ?? [];

  say("probe", {
    deal: id,
    single_status: one.__status ?? 200,
    single_returned: oneTasks.length,
    single_foreign_entity_ids: foreign,
    single_honoured: one.__status ? false : oneTasks.length > 0 && foreign === 0,
    list_status: many?.__status ?? (many ? 200 : "skipped"),
    list_returned: manyTasks.length,
    list_distinct_entities: manyIds.size,
    list_honoured: many && !many.__status ? manyIds.size <= 2 && manyTasks.length > 0 : false,
    with_updated_at_window: comboTasks.length,
    // Метадані підрахунку: якщо Kommo їх дає — обсяг рахується 1 запитом, а не пагінацією.
    count_meta: Object.keys(one).filter((k) => /total|page_count/i.test(k)),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 2. ОБСЯГ 30 / 60 / 180 днів по `updated_at` — скільком задачам відповідає
// поточне вікно синку. Це і є ціна проходу в запитах.
// ─────────────────────────────────────────────────────────────────────────────
async function countWindow(fromUnix, toUnix, collect) {
  const enc = encodeURIComponent;
  const limit = 250;
  let page = 1;
  let total = 0;
  for (;;) {
    const d = await kommo(
      `/api/v4/tasks?limit=${limit}&page=${page}` +
        `&${enc("filter[updated_at][from]")}=${fromUnix}&${enc("filter[updated_at][to]")}=${toUnix}`
    );
    if (d.__status) throw new Error(`Kommo ${d.__status}: ${d.__body}`);
    const raw = d._embedded?.tasks ?? [];
    total += raw.length;
    if (collect) collect(raw);
    if (raw.length < limit) break;         // коротка сторінка = вибірку вичерпано
    if (++page > 2000) {                   // та сама стеля, що в forEachTaskPage
      console.error(`🔴 СТЕЛЯ 2000 сторінок у вікні ${fromUnix}..${toUnix} — число НЕПОВНЕ.`);
      break;
    }
  }
  return { total, pages: page };
}

async function stepVolume() {
  for (const days of [30, 60, 180]) {
    const before = calls;
    const r = await countWindow(now - days * DAY, now);
    say(`volume_${days}d`, { tasks: r.total, pages: r.pages, kommo_calls: calls - before });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 3. ЧАСТКА ПІСЛЯ ФІЛЬТРА ЗА ВОРОНКОЮ — скільки із задач вікна взагалі
// стосуються FC-угод. Це число вирішує, чи фільтр вартий заходу: якщо після
// нього лишається 90%, оптимізувати нічого.
//
// Рахується БЕЗ `kommo_tasks` (її на проді ще немає — #76 не викочено):
// entity_id з відповіді Kommo зіставляються з `deals` напряму.
// ─────────────────────────────────────────────────────────────────────────────
async function stepFunnel(days = 30) {
  const leadIds = new Set();
  let all = 0;
  let leads = 0;
  const r = await countWindow(now - days * DAY, now, (raw) => {
    all += raw.length;
    for (const t of raw) {
      if ((t.entity_type ?? null) === "leads") {
        leads += 1;
        leadIds.add(Number(t.entity_id));
      }
    }
  });
  const ids = [...leadIds];
  const [fc] = await pg(
    `SELECT count(*)::int AS in_fc,
            count(*) FILTER (WHERE psm.funnel_stage <> 'paid')::int AS in_fc_active
       FROM deals d ${ACTIVE_FC_JOIN}
      WHERE d.kommo_id = ANY($1::bigint[]) AND d.pipeline_id IN ${FC}`,
    [ids]
  );
  say(`funnel_share_${days}d`, {
    tasks_total: r.total,
    tasks_on_leads: leads,
    distinct_lead_entities: ids.length,
    entities_in_fc: fc.in_fc,
    entities_in_fc_active: fc.in_fc_active,
    share_entities_fc_pct: ids.length ? +((fc.in_fc / ids.length) * 100).toFixed(1) : null,
    note: "частка по СУТНОСТЯХ; частка по рядках задач вимагає поштучного зіставлення — див. dry",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 4 (доповнення). `entity_type = NULL` — скільки задач приходять без типу.
// Колонка nullable, і в критерії NULL зіпсував би `GROUP BY entity_type,entity_id`:
// задача без типу не приліпиться до угоди, але й не зникне.
// ─────────────────────────────────────────────────────────────────────────────
async function stepNulls(days = 30) {
  const byType = new Map();
  await countWindow(now - days * DAY, now, (raw) => {
    for (const t of raw) {
      const k = t.entity_type ?? "__NULL__";
      byType.set(k, (byType.get(k) ?? 0) + 1);
    }
  });
  const total = [...byType.values()].reduce((a, b) => a + b, 0);
  const nulls = byType.get("__NULL__") ?? 0;
  say(`entity_type_${days}d`, {
    total,
    by_type: Object.fromEntries(byType),
    null_rows: nulls,
    null_pct: total ? +((nulls / total) * 100).toFixed(2) : 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 5 (доповнення). СУХИЙ ЗАМІР 383 → ~130. Критерій НЕ ЧІПАЄТЬСЯ; задачі
// підкладаються тимчасовою таблицею в ТРАНЗАКЦІЇ З ROLLBACK — у прод не влітає
// жодного рядка. Дає обидва числа з одного проходу: без задач і з задачами.
// ─────────────────────────────────────────────────────────────────────────────
async function stepDry(days = 14) {
  const pairs = [];
  await countWindow(now - days * DAY, now, (raw) => {
    for (const t of raw) {
      if ((t.entity_type ?? null) === "leads" && t.updated_at > 0) {
        pairs.push([Number(t.entity_id), t.updated_at]);
      }
    }
  });
  const ids = pairs.map((p) => p[0]);
  const tss = pairs.map((p) => new Date(p[1] * 1000).toISOString());
  const rows = await pg(
    `SELECT
       (SELECT count(*)::int FROM deals d ${ACTIVE_FC_JOIN}
          WHERE ${ACTIVE_FC_WHERE}) AS fc_active,
       (SELECT count(*)::int FROM deals d ${ACTIVE_FC_JOIN}
          WHERE ${ACTIVE_FC_WHERE}
            AND NOT EXISTS (SELECT 1 FROM UNNEST($1::bigint[], $2::timestamptz[]) AS x(id, ts)
                             WHERE x.id = d.kommo_id)) AS fc_active_without_task,
       (SELECT count(DISTINCT d.kommo_id)::int FROM deals d ${ACTIVE_FC_JOIN}
          WHERE ${ACTIVE_FC_WHERE}
            AND EXISTS (SELECT 1 FROM UNNEST($1::bigint[], $2::timestamptz[]) AS x(id, ts)
                         WHERE x.id = d.kommo_id)) AS fc_active_with_task`,
    [ids, tss]
  );
  const r = rows[0];
  say(`dry_${days}d`, {
    task_rows_on_leads: pairs.length,
    fc_active: r.fc_active,
    fc_active_with_task: r.fc_active_with_task,
    fc_active_without_task: r.fc_active_without_task,
    coverage_pct: r.fc_active ? +((r.fc_active_with_task / r.fc_active) * 100).toFixed(1) : null,
    note: "«383 → ~130» = скільком угодам задача знімає ознаку застрягання; критерій НЕ виконувався — це заготовка під нього",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// КРОК 6 (доповнення). РОЗМІР `kommo_tasks` у МБ.
// Таблиці на проді ЩЕ НЕМА (#76 не викочено) → друкуємо і факт, і модель:
// ширина рядка з `schema.sql` × заміряний обсяг.
// ─────────────────────────────────────────────────────────────────────────────
async function stepSize() {
  const [exists] = await pg(`SELECT to_regclass('kommo_tasks') IS NOT NULL AS ok`);
  if (exists.ok) {
    const [s] = await pg(
      `SELECT pg_size_pretty(pg_total_relation_size('kommo_tasks')) AS total,
              pg_size_pretty(pg_relation_size('kommo_tasks')) AS heap,
              pg_size_pretty(pg_indexes_size('kommo_tasks')) AS idx,
              (SELECT count(*)::bigint FROM kommo_tasks) AS rows`
    );
    return say("size", { measured: s });
  }
  // Модель: heap ~108 Б/рядок (24 tuple header + 80 даних + 4 line pointer),
  // btree(kommo_id) ~32, btree(entity_type,entity_id,updated_at) ~48, btree(updated_at) ~32.
  const perRow = 108 + 32 + 48 + 32;
  const model = {};
  for (const n of [100_000, 250_000, 500_000, 1_000_000]) {
    model[n] = `${((n * perRow) / 1024 / 1024).toFixed(0)} МБ`;
  }
  say("size", { measured: null, table_absent: true, bytes_per_row: perRow, model });
}

// ─────────────────────────────────────────────────────────────────────────────
const steps = [
  ["probe", stepProbe], ["volume", stepVolume], ["funnel", stepFunnel],
  ["nulls", stepNulls], ["dry", stepDry], ["size", stepSize],
];
for (const [name, fn] of steps) {
  if (!want(name)) continue;
  try {
    await fn();
  } catch (e) {
    console.error(`🔴 крок ${name} впав: ${e.message}`);
    out[name] = { error: e.message };
  }
}
console.log(`\n--- ІТОГО --- kommo_calls=${calls}`);
console.log(JSON.stringify(out, null, 1));
