/**
 * ☎️ ПОКЛИКОВИЙ СИНК ДЗВІНКІВ RINGOSTAT → `ringostat_calls`.
 *
 * ⚠️ НЕ ЧІПАЄ наявну `syncRingostatCalls` — та рахує ЛІЧИЛЬНИК по тімлідах у
 * `statistics_values` і живе як жила. Тут інша сутність: самі дзвінки.
 *
 * 🔴 Чому окрема джоба, а не «розширимо існуючу». Агрегат «Статистик» —
 * зовнішній контракт із розділом, який працює. Домішати до нього запис 580 тис.
 * рядків означало б, що падіння покликового синку валить і цифру статистик.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { normalizePhone, clientPhoneOf } from "../utils/phone.js";
import { dedupeById } from "./dealContactPairs.js";

const FIELDS = "calldate,caller,dst,n_alias,billsec,duration,call_type,disposition,recording,uniqueid,employee_fio";

export interface RawCall {
  uniqueid?: string; calldate?: string; caller?: string; dst?: string; n_alias?: string;
  billsec?: number | string; duration?: number | string; call_type?: string;
  disposition?: string; recording?: string; employee_fio?: string;
}

/** Один запит до Ringostat за вікном. Період — рядки «YYYY-MM-DD HH:MM:SS». */
export async function fetchCalls(from: string, to: string): Promise<RawCall[]> {
  const url = `https://api.ringostat.net/calls/list?export_type=json`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&fields=${FIELDS}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { headers: { "Auth-key": config.ringostat.authKey }, signal: ctrl.signal });
    const txt = await res.text();
    let arr: unknown;
    try { arr = JSON.parse(txt); } catch { throw new Error(`Ringostat non-JSON: ${txt.slice(0, 120)}`); }
    if (!Array.isArray(arr)) throw new Error(`Ringostat unexpected: ${txt.slice(0, 120)}`);
    return arr as RawCall[];
  } finally { clearTimeout(t); }
}

/**
 * Запис пачки. 🔴 ДЕДУП ЗА `uniqueid` ОБОВʼЯЗКОВИЙ — урок інциденту 03.08.2026:
 * `ON CONFLICT DO UPDATE` не може зачепити один рядок двічі, і батч із дублем
 * кладе всю джобу. Ringostat дублів не обіцяв, але й Kommo не обіцяв.
 */
export async function upsertCalls(calls: RawCall[]): Promise<number> {
  const rows = dedupeById(
    calls.filter((c) => c.uniqueid && c.calldate)
      .map((c) => ({ id: c.uniqueid as unknown as number, c }))
  ).map((x) => x.c);
  if (!rows.length) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const cols = ["uniqueid", "calldate", "call_type", "disposition", "billsec", "duration",
                  "caller", "dst", "n_alias", "recording", "employee_fio", "client_phone"];
    const vals: unknown[] = [];
    const ph: string[] = [];
    chunk.forEach((c, j) => {
      ph.push(`(${cols.map((_, k) => `$${j * cols.length + k + 1}`).join(",")})`);
      vals.push(
        c.uniqueid, c.calldate, c.call_type ?? "unknown", c.disposition ?? null,
        Number(c.billsec ?? 0) || 0, Number(c.duration ?? 0) || 0,
        c.caller ?? null, c.dst ?? null, c.n_alias ?? null, c.recording ?? null,
        c.employee_fio ?? null, clientPhoneOf(c.call_type, c.caller, c.dst));
    });
    const r = await pool.query(
      `INSERT INTO ringostat_calls (${cols.join(",")}) VALUES ${ph.join(",")}
       ON CONFLICT (uniqueid) DO UPDATE SET
         disposition = EXCLUDED.disposition, billsec = EXCLUDED.billsec,
         duration = EXCLUDED.duration, recording = EXCLUDED.recording,
         employee_fio = EXCLUDED.employee_fio, client_phone = EXCLUDED.client_phone,
         synced_at = now()`, vals);
    written += r.rowCount ?? 0;
  }
  return written;
}

/**
 * Звʼязка дзвінок → клієнт і дзвінок → менеджер. Окремим проходом, бо обидва
 * джерела (телефони контактів, мапінг ПІБ) наповнюються незалежно від дзвінків:
 * дзвінок, що прийшов раніше за контакт, має звʼязатись пізніше, а не загубитись.
 *
 * 🔴 ПІБ НЕ ВГАДУЄМО. `employee_fio` порожній у ~20% — там `manager_id` лишається
 * NULL, і на екрані буде «менеджер невідомий». Вгадувати по номеру заборонено:
 * один внутрішній номер за рік міняє власника, і ми приписали б дзвінки не тому.
 */
export async function linkCalls(): Promise<{ byPhone: number; byFio: number }> {
  const byPhone = await pool.query(
    `UPDATE ringostat_calls rc SET client_key = m.ck
       FROM (
         SELECT cp.phone, (array_agg(d.client_key ORDER BY d.closed_at_kommo DESC NULLS LAST))[1] AS ck
           FROM contact_phones cp
           JOIN deal_contacts dc ON dc.contact_id = cp.contact_id
           JOIN deals d ON d.kommo_id = dc.deal_kommo_id AND d.client_key IS NOT NULL
          GROUP BY cp.phone
       ) m
      WHERE rc.client_phone = m.phone AND rc.client_key IS DISTINCT FROM m.ck`);
  // 🔴 ПІБ ЗБІГАЄТЬСЯ НЕ ДОСЛІВНО. Ringostat віддає ПОВНЕ ПІБ («Крицька Діана
  // Геннадіївна»), а `managers.name` буває і коротким («Крицька Діана»), і повним.
  // Точний збіг дав би нуль мапінгів і тихо перетворив би ВСІ дзвінки на
  // «менеджер невідомий». Правило те саме, що в агрегаті «Статистик»
  // (`resolveLead`): прізвище+імʼя без пробілів, з нормалізацією апострофа.
  //
  // 🔴 КЛЮЧ ЗРІЗАЄТЬСЯ З ОБОХ БОКІВ (фікс 04.08.2026, заміряно). Було: ПІБ дзвінка
  // різався до двох слів, а `managers.name` порівнювалось ЦІЛИМ. Для менеджерів із
  // тричленним імʼям у базі (55 записів, з них 19 активних) ключі не сходились
  // НІКОЛИ — «Демчук Вікторія Олександрівна» ≠ «демчуквікторія». Наслідок:
  // 111 366 дзвінків (26.8% усіх) належали АКТИВНИМ менеджерам і тихо лишались
  // «менеджер невідомий». Симптом виглядав як «цих людей немає в managers»,
  // хоча вони там були — асиметрія ховала сама себе.
  //
  // 🟢 ЗВІЛЬНЕНИМ ПРИПИСУЄМО (рішення власника 04.08.2026): «дзвонила конкретна
  //    людина (звільнена)» корисніше за «невідомо» — історія має казати правду.
  //    Тому фільтра `is_active` тут НЕМА.
  //    ⚠️ Це НЕ відкриває деактивованих на екранах ОЦІНКИ: там свій фільтр, і він
  //    працює (перевірено поведінкою 04.08.2026 — деактивована «Мельник Лілія» з
  //    7 виграними угодами за 90 днів не зʼявляється ні в `successByMgr`, ні в
  //    `stuckDealsGrouped`). Звʼязка дзвінка — це ІСТОРІЯ, а не рейтинг.
  //    ⚠️ Хто показує історію дзвінків — МУСИТЬ підписати звільненого звільненим,
  //    інакше він читається як діючий. Екрана дзвінків ще немає; вимога записана
  //    в docs/RINGOSTAT_CALLS.md, щоб не загубилась.
  //
  // 🔒 ДУБЛІ КЛЮЧА — БЕРЕМО АКТИВНОГО, і це НЕ здогад: серед активних менеджерів
  // однакових ключів НУЛЬ (заміряно), а всі 8 колізій — це та сама людина двома
  // рядками (активний + деактивований). Після зняття фільтра `is_active` цей
  // пріоритет став ОБОВʼЯЗКОВИМ, а не запобіжним: тепер обидва рядки в вибірці. Якби колись зʼявились двоє РІЗНИХ
  // активних із однаковим прізвище+імʼя — `DISTINCT ON` узяв би меншший id, тож
  // цей випадок стереже тест #27c: він має впасти, а не мовчки вгадати.
  const byFio = await pool.query(
    `UPDATE ringostat_calls rc SET manager_id = mm.id
       FROM (
         SELECT DISTINCT ON (k) id, k FROM (
           SELECT id, is_active,
                  regexp_replace(lower(translate(
                    (regexp_split_to_array(btrim(name), '\\s+'))[1] || ' ' ||
                    COALESCE((regexp_split_to_array(btrim(name), '\\s+'))[2], ''),
                    'ʼ’\`', '')), '\\s+', '', 'g') AS k
             FROM managers   -- 🟢 включно з деактивованими (рішення власника 04.08.2026)
         ) x ORDER BY k, is_active DESC, id
       ) mm
      WHERE rc.employee_fio IS NOT NULL
        AND mm.k = regexp_replace(
              lower(translate(
                (regexp_split_to_array(btrim(rc.employee_fio), '\\s+'))[1] || ' ' ||
                COALESCE((regexp_split_to_array(btrim(rc.employee_fio), '\\s+'))[2], ''),
                'ʼ’\`', '')), '\\s+', '', 'g')
        AND rc.manager_id IS DISTINCT FROM mm.id`);
  return { byPhone: byPhone.rowCount ?? 0, byFio: byFio.rowCount ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ШТАТНИЙ ПРОХІД: останні `hours` годин. Викликати через `runJob` — щоб банер
 * бачив джобу (урок: ручні шляхи повз обгортку невидимі для нагляду).
 */
export async function syncCalls(hours = 3): Promise<{ fetched: number; written: number }> {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  const calls = await fetchCalls(fmt(from), fmt(to));
  const written = await upsertCalls(calls);
  await linkCalls();
  console.log(`syncCalls: отримано ${calls.length}, записано ${written}.`);
  return { fetched: calls.length, written };
}

/**
 * БЕКФІЛ — ПОМІСЯЧНО, з паузою МІЖ місяцями. Не одним запитом за весь час:
 * місяць = ~48 тис. записів, рік однією відповіддю — це і памʼять, і ризик
 * обриву без прогресу.
 */
export async function backfillCalls(months = 12, pauseMs = 3000): Promise<{ months: number; fetched: number; written: number }> {
  const now = new Date();
  let fetched = 0, written = 0;
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const from = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01 00:00:00`;
    const to = new Date(end.getTime() - 1000);
    const toStr = `${to.getUTCFullYear()}-${pad(to.getUTCMonth() + 1)}-${pad(to.getUTCDate())} 23:59:59`;
    const calls = await fetchCalls(from, toStr);
    const w = await upsertCalls(calls);
    fetched += calls.length; written += w;
    console.log(`  ${from.slice(0, 7)}: отримано ${calls.length}, записано ${w}`);
    if (i > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  const linked = await linkCalls();
  console.log(`backfillCalls: ${fetched} дзвінків, звʼязано по телефону ${linked.byPhone}, по ПІБ ${linked.byFio}.`);
  return { months, fetched, written };
}

/** Для тестів: нормалізація номера клієнта — та сама функція, що в проді. */
export { normalizePhone };
