/**
 * 🔄 СЕЙФ — ДЗЕРКАЛО GOOGLE-ТАБЛИЦІ (Роман 12.10.2026, зустріч TOP Weekly 08.10: «джерело — таблиця сейфу, Сергій
 * вносить туди; дашборд читає таблицю автоматично; у зворотний бік нічого не пише»).
 *
 * Чисте ядро без мережі: розбір значень вкладки «Сейф» (`parseSafeSheet`) і звірка з рахунком «Сейф» у базі
 * (`reconcileSafe`). Мережа й розклад — `jobs/syncSafe.ts`.
 *
 * 🔑 КЛЮЧ РЯДКА — вміст (дата, сума, валюта, «на що», угода) + номер повтору серед однакових (`parseSafeCsv`). Вставка
 * чи сортування рядків у таблиці ключа не міняють; правка суми / дати / опису = «старий зник + новий зʼявився»
 * (історія лишається). КАТЕГОРІЯ, «Фінансист» і «сума в грн» до ключа не входять — їхня зміна ОНОВЛЮЄ запис: Таня
 * зводить категорії в одну систему, і масове перейменування не мусить виглядати як масове зникнення. Перенесені 05.10
 * записи мають ключ за старою формулою (з категорією) — звірка впізнає їх за `legacyKey` і переключає на новий ключ.
 *
 * 🛡 ТРИ ВІДМОВИ, І КОЖНА — БЕЗ ЖОДНОГО ЗАПИСУ (дані лишаються останніми збереженими):
 *  · змінилась шапка (колонки) — `SafeSheetError` «структура»;
 *  · таблиця прочиталась порожньою — «порожньо»: нуль рядків — це аварія читання, а не «0 нових» (правило зони
 *    jobs-sync «зелена джоба ≠ дані йдуть»);
 *  · за один прохід «зникло» понад 10% живих рядків — «масове зникнення» (неповне читання, фільтр у таблиці). Поріг —
 *    Роман 12.10.2026 («так»).
 * Тримають #1248…#1248c.
 */
import type { Db } from "./finance.js";
import { parseSafeCsv, manualBalances, type SafeRow } from "./bankManual.js";

/** Колонки вкладки «Сейф» на своїх місцях (замір 12.10.2026). Порожня назва — колонка без шапки, вміст не читаємо. */
export const SAFE_HEADER = ["Дата", "Сумма", "Валюта", "Текущий курс", "Сумма в грн", "На що", "Кому (ID)", "Категория", "", "Фінансист"] as const;
/** Звідки синк дзеркалить таблицю: раніше — історія 2024–2025 у дашборд не переноситься (рішення 05.10). */
export const SAFE_FROM = "2026-01-01";
/** Позначка рядка, що зник із таблиці (повертається сам, щойно рядок зʼявиться знову). */
export const VANISHED = "зник із таблиці";
export const MAX_VANISH_SHARE = 0.1;

export class SafeSheetError extends Error {
  constructor(public kind: "structure" | "empty" | "mass-vanish", message: string) { super(message); }
}

export interface SafeSheet {
  rows: SafeRow[];
  skipped: { balance: number; zero: number; before: number; bad: number };
  /** Залишки з шапки таблиці (рядки над «Дата»: «, UAH, 148746») — для звірки з залишком дашборду. */
  sheetBalances: Record<string, number>;
}

/** Значення вкладки → рядки Сейфу. Шапка — рівно `SAFE_HEADER` на своїх місцях, інакше відмова «структура». */
export function parseSafeSheet(values: readonly (readonly string[])[], from: string = SAFE_FROM): SafeSheet {
  const rows = values.map((r) => r.map((x) => String(x ?? "")));
  const head = rows.findIndex((r) => (r[0] ?? "").trim() === "Дата");
  if (head < 0) throw new SafeSheetError("structure", "у вкладці «Сейф» немає рядка шапки, що починається з «Дата»");
  const got = SAFE_HEADER.map((_, i) => (rows[head][i] ?? "").trim());
  const bad = SAFE_HEADER.map((want, i) => (want && got[i] !== want ? `колонка ${i + 1}: чекали «${want}», є «${got[i]}»` : null)).filter(Boolean);
  if (bad.length) throw new SafeSheetError("structure", `змінилась шапка таблиці — ${bad.join("; ")}`);
  const sheetBalances: Record<string, number> = {};
  for (const r of rows.slice(0, head)) {
    const ccy = (r[1] ?? "").trim().toUpperCase(), amount = Number(String(r[2] ?? "").replace(/[\s\u00a0]/g, "").replace(",", "."));
    if (/^(UAH|USD|EUR)$/.test(ccy) && String(r[2] ?? "").trim() !== "" && Number.isFinite(amount)) sheetBalances[ccy] = amount;
  }
  let parsed;
  try { parsed = parseSafeCsv(rows, from); } catch (e) { throw new SafeSheetError("structure", (e as Error).message); }
  if (!parsed.rows.length) throw new SafeSheetError("empty", "таблиця прочиталась без жодної операції — нічого не змінено");
  return { rows: parsed.rows, skipped: parsed.skipped, sheetBalances };
}

/** 8-значний номер угоди Kommo з «Кому (ID)»; інше (текст, коротке число) — null, сирий текст лишається в `deal_ref`. */
export const dealKommoId = (deal: string): number | null => (/^\d{8}$/.test(deal.trim()) ? Number(deal.trim()) : null);

export interface ReconcileResult { seen: number; inserted: number; vanished: number; restored: number; updated: number; live: number }
type RateOf = (ccy: string, day: string) => Promise<number>;

/**
 * Звірка таблиці з рахунком «Сейф»: нове — додати; зникле — позначити «зник із таблиці» (не стирати); повернене —
 * відновити; у знайомих рядках оновити «Фінансист», угоду й гривню. Записи, внесені колись у дашборді, звірка не чіпає
 * (їх прибрано разовим кроком схеми). Повтор без змін у таблиці — нуль змін.
 */
export async function reconcileSafe(db: Db, accountId: number, sheet: SafeSheet, rateOf: RateOf, from: string = SAFE_FROM): Promise<ReconcileResult> {
  const have = (await db.query(`SELECT id, external_tx_id AS key, deleted_at IS NOT NULL AS deleted, deleted_reason, amount_uah::float8 AS uah,
      fin_checked, deal_ref, deal_kommo_id, counterparty_name AS cat FROM bank_transactions
     WHERE account_id = $1 AND external_tx_id LIKE 'safe-import:%' AND (booked_at AT TIME ZONE 'Europe/Kyiv')::date >= $2::date`, [accountId, from])).rows as
    { id: number; key: string; deleted: boolean; deleted_reason: string | null; uah: number; fin_checked: boolean | null; deal_ref: string | null; deal_kommo_id: string | null; cat: string | null }[];
  const byKey = new Map(have.map((h) => [h.key, h]));
  // Рядок таблиці ↔ запис: за ключем, а перенесений 05.10 — за старим ключем (`legacyKey`), лише якщо нового ще немає.
  const match = new Map<string, (typeof have)[number]>();
  for (const r of sheet.rows) {
    const h = byKey.get(r.key) ?? (r.legacyKey && !byKey.has(r.key) ? byKey.get(r.legacyKey) : undefined);
    if (h && ![...match.values()].includes(h)) match.set(r.key, h);
  }
  const matched = new Set([...match.values()].map((h) => h.id));
  const live = have.filter((h) => !h.deleted);
  const vanish = live.filter((h) => !matched.has(h.id));
  if (live.length && vanish.length > MAX_VANISH_SHARE * live.length)
    throw new SafeSheetError("mass-vanish", `за один прохід зникло б ${vanish.length} з ${live.length} рядків (понад ${MAX_VANISH_SHARE * 100}%) — нічого не змінено; перевірте фільтр чи вміст таблиці`);
  let inserted = 0, restored = 0, updated = 0;
  for (const r of sheet.rows) {
    const h = match.get(r.key);
    const did = dealKommoId(r.deal);
    if (!h) {
      const rate = r.currency === "UAH" ? 1 : r.rate ?? (await rateOf(r.currency, r.day));
      const uah = r.uah ?? Math.round(r.amount * rate * 100) / 100;
      const res = await db.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, processed_at, counterparty_name,
          purpose, amount, currency, fx_rate, amount_uah, manual_kind, deal_ref, deal_kommo_id, fin_checked)
        VALUES ($1, $2, $3, ($4::date + time '12:00') AT TIME ZONE 'Europe/Kyiv', ($4::date + time '12:00') AT TIME ZONE 'Europe/Kyiv', $5, $6, $7, $8, $9, $10, 'op', $11, $12, $13)
        ON CONFLICT (account_id, external_tx_id) DO NOTHING RETURNING id`,
        [accountId, r.amount >= 0 ? "in" : "out", r.key, r.day, r.category || "Сейф", r.purpose || null, r.amount, r.currency, rate, uah,
          r.deal || null, did, r.fin ?? null]);
      if (res.rows.length) inserted++;
      continue;
    }
    const restore = h.deleted && h.deleted_reason === VANISHED;
    const uah = r.uah ?? h.uah;
    const cat = r.category || "Сейф";
    const change = restore || h.key !== r.key || Math.abs(uah - h.uah) > 0.005 || (r.fin ?? null) !== h.fin_checked || (r.deal || null) !== h.deal_ref
      || (did == null ? null : String(did)) !== (h.deal_kommo_id == null ? null : String(h.deal_kommo_id)) || cat !== h.cat;
    if (!change) continue;
    await db.query(`UPDATE bank_transactions SET external_tx_id = $6, counterparty_name = $7, amount_uah = $2, fin_checked = $3, deal_ref = $4, deal_kommo_id = $5
        ${restore ? ", deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL" : ""} WHERE id = $1`,
      [h.id, uah, r.fin ?? null, r.deal || null, did, r.key, cat]);
    if (restore) restored++; else updated++;
  }
  for (const h of vanish)
    await db.query(`UPDATE bank_transactions SET deleted_at = now(), deleted_reason = $2 WHERE id = $1 AND deleted_at IS NULL`, [h.id, VANISHED]);
  return { seen: sheet.rows.length, inserted, vanished: vanish.length, restored, updated, live: live.length - vanish.length + inserted + restored };
}

export interface SafeSyncState {
  configured: boolean;
  lastOkAt: string | null; lastTryAt: string | null; lastError: string | null; lastErrorAt: string | null;
  result: ReconcileResult | null;
  sheetBalances: Record<string, number> | null;
  dashBalances: { currency: string; amount: number; asOf: string | null }[];
  /** Валюти, де залишок дашборду ≠ шапці таблиці (на момент останнього успішного синку) — звірка без людини. */
  mismatch: { currency: string; sheet: number; dashboard: number }[];
}

/** Стан для вікна Сейфу: «дані станом на …», остання помилка, залишки таблиці й дашборду. */
export async function safeSyncStatus(db: Db, configured = true): Promise<SafeSyncState> {
  const s = (await db.query(`SELECT last_ok_at, last_try_at, last_error, last_error_at, result, sheet_balances FROM safe_sync_state WHERE id = 1`)).rows[0];
  const acc = (await db.query(`SELECT id FROM bank_accounts WHERE bank = 'manual' AND label = 'Сейф' ORDER BY id LIMIT 1`)).rows[0];
  const dash = acc ? await manualBalances(db, acc.id) : [];
  const sheet = (s?.sheet_balances ?? null) as Record<string, number> | null;
  const mismatch = sheet ? Object.entries(sheet).map(([currency, v]) => ({ currency, sheet: v, dashboard: dash.find((d) => d.currency === currency)?.amount ?? 0 }))
    .filter((m) => Math.abs(m.sheet - m.dashboard) > 0.5) : [];
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return { configured, lastOkAt: iso(s?.last_ok_at), lastTryAt: iso(s?.last_try_at), lastError: s?.last_error ?? null, lastErrorAt: iso(s?.last_error_at),
    result: s?.result ?? null, sheetBalances: sheet, dashBalances: dash, mismatch };
}

/** Записати підсумок спроби. Успіх НЕ стирає останню помилку (правило зони), лише ставить новіший `last_ok_at`. */
export async function saveSafeSyncState(db: Db, ok: { result: ReconcileResult; sheetBalances: Record<string, number> } | { error: string }): Promise<void> {
  if ("error" in ok)
    await db.query(`INSERT INTO safe_sync_state (id, last_try_at, last_error, last_error_at) VALUES (1, now(), $1, now())
      ON CONFLICT (id) DO UPDATE SET last_try_at = now(), last_error = $1, last_error_at = now()`, [ok.error]);
  else
    await db.query(`INSERT INTO safe_sync_state (id, last_try_at, last_ok_at, result, sheet_balances) VALUES (1, now(), now(), $1, $2)
      ON CONFLICT (id) DO UPDATE SET last_try_at = now(), last_ok_at = now(), result = $1, sheet_balances = $2`, [JSON.stringify(ok.result), JSON.stringify(ok.sheetBalances)]);
}

