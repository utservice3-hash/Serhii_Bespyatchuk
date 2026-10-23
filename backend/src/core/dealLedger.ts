/**
 * 📒 УГОДА «ЯК У ТЕТЯНИ» — чистий модуль без імпортів (задача #5583, прохід 2, 23.10.2026). Відтворює блоки вкладки
 * «Сделки» таблиці «UTS Сделки Сводка», які збирає її скрипт «Обновить сделки» (`main`, прочитано 23.10.2026):
 *  · Kommo: «Приход 1–5» і «Расход 1–5» за полем «Тип оплаты» (колонки L–R; знак розходу — мінус);
 *  · 1С: реалізації з сервісу `costinvoice` (вкладка «Расх из 1C», колонки S–AA) — прихід за ОРГАНІЗАЦІЄЮ (ТОВ «ЮТС» — з
 *    ПДВ; список готівкових — нал; решта — без ПДВ), розхід за «RashodType»;
 *  · оплати клієнтів з 1С: сервіс `paydata` (вкладка «1С») — сума по угоді, за тією самою організацією;
 *  · бюджет — формула `calcBudget_` (колонки S і AB; та сама, що на скріншоті Тетяни і в полі «Бюджет» Kommo).
 * 📐 Замір 23.10.2026 на жовтні (273 угоди): Kommo — 272/273, прихід 1С — 271/271, організація — 271/271.
 * Валюта: скрипт додає EUR/USD до гривні як є; ми валютних рядків до гривневих колонок НЕ додаємо, а показуємо окремо
 * (і просимо перевірити) — сума в євро під підписом «₴» була б вигаданим числом.
 */

/** Організації 1С за типом оплати — аркуш «Настройки» таблиці Тетяни (A3 — з ПДВ, C3:C — готівка), прочитано 23.10.2026. */
export const ONEC_VAT_ORGS = ['ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"'] as const;
export const ONEC_CASH_ORGS = ["ФОП ШЕВЧУК ВІКТОР ВАСИЛЬОВИЧ", "ФОП ЯЦИК ДМИТРО СЕРГІЙОВИЧ", "Фізична особа", "ФОП Беспятчук Сергій Степанович",
  "СТУПАКІВСЬКИЙ О. О. МОНО", "Облік сейфу"] as const;
export type PayKind = "vat" | "novat" | "cash";
/** Тип оплати за організацією 1С: ЮТС — з ПДВ, готівкові — нал, решта (АвтоМув тощо) — без ПДВ (у скрипті V = усе − U − W). */
export function orgKind(org: string | null | undefined): PayKind {
  const o = String(org ?? "").trim();
  if ((ONEC_VAT_ORGS as readonly string[]).includes(o)) return "vat";
  if ((ONEC_CASH_ORGS as readonly string[]).includes(o)) return "cash";
  return "novat";
}

/** Назви типів оплати в Kommo й 1С (колонки L–R / X–AA). */
export const TYPE_IN: Record<string, PayKind> = { "Безнал с НДС": "vat", "Безнал без НДС": "novat", "Наличные": "cash" };
export const TYPE_OUT: Record<string, keyof Flows["out"]> = { "Безнал с НДС": "vat", "Безнал без НДС": "novat", "Оплата на выгрузке": "unload", "Наличные": "cash" };

/** Приходи (плюс) і розходи (мінус) угоди за типами. */
export interface Flows { in: { vat: number; novat: number; cash: number }; out: { vat: number; novat: number; unload: number; cash: number } }
export const emptyFlows = (): Flows => ({ in: { vat: 0, novat: 0, cash: 0 }, out: { vat: 0, novat: 0, unload: 0, cash: 0 } });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Число з 1С / Kommo: «24 000», «152 783,4», 129037; порожнє чи не число — `null`. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Дата 1С «1.11.2023 0:00:00» → «2023-11-01». «01.01.2001» — сентинел 1С «дати немає» (заміряно: сотні рядків) → `null`. */
export function onecDate(v: unknown): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(v ?? "").trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return iso === "2001-01-01" ? null : iso;
}
const dealOf = (v: unknown): number | null => { const s = String(v ?? "").trim(); return /^\d{8}$/.test(s) ? Number(s) : null; };
const isUah = (c: unknown) => /^(грн|uah)?$/i.test(String(c ?? "").trim());

/** Рядок реалізації 1С (`costinvoice`) з номером угоди; розходи — уже за типами, зі знаком мінус. */
export interface OnecInvoice { deal: number; number: string; organization: string; kontragent: string; docOn: string | null; actOn: string | null; sum: number; currency: string; out: Flows["out"] }
export function parseInvoices(json: unknown): OnecInvoice[] {
  const rows = Array.isArray(json) ? json : [json];
  const out: OnecInvoice[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const deal = dealOf(x?.Deal);
    const sum = num(x?.Sum);
    if (deal == null || sum == null) continue;
    const o = { vat: 0, novat: 0, unload: 0, cash: 0 };
    for (const k of [1, 2, 3]) {
      const t = TYPE_OUT[String(x[`RashodType${k}`] ?? "").trim()];
      const a = num(x[`Rashod${k}`]);
      if (t && a) o[t] = r2(o[t] - a);
    }
    out.push({ deal, number: String(x.Number ?? "").trim(), organization: String(x.Organization ?? "").trim(), kontragent: String(x.Kontragent ?? "").trim(),
      docOn: onecDate(x.Data), actOn: onecDate(x.DateAct), sum, currency: String(x.Currency ?? "").trim() || "грн", out: o });
  }
  return out;
}

/** Оплата клієнта в 1С (`paydata`) з номером угоди. Менеджера (там телефони) і коментар не беремо. */
export interface OnecPayment { deal: number; organization: string; kontragent: string; paidOn: string | null; sum: number; currency: string }
export function parsePayments(json: unknown): OnecPayment[] {
  const rows = Array.isArray(json) ? json : [json];
  const out: OnecPayment[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const deal = dealOf(x?.Deal);
    const sum = num(x?.Sum);
    if (deal == null || sum == null) continue;
    out.push({ deal, organization: String(x.Organization ?? "").trim(), kontragent: String(x.Kontragent ?? "").trim(), paidOn: onecDate(x.Data),
      sum, currency: String(x.Currency ?? "").trim() || "грн" });
  }
  return out;
}

/** Блок 1С угоди: організація (перша, як VLOOKUP скрипта), прихід за організацією, розхід за типами; валюта — окремо. */
export interface OnecBlock { organization: string; flows: Flows; budget: number | null; fx: { currency: string; sum: number }[]; actOn: string | null }
export function onecBlock(rows: readonly Pick<OnecInvoice, "organization" | "sum" | "currency" | "out" | "actOn">[]): OnecBlock | null {
  if (!rows.length) return null;
  const f = emptyFlows();
  const fx = new Map<string, number>();
  for (const r of rows) {
    if (!isUah(r.currency)) { fx.set(r.currency, r2((fx.get(r.currency) ?? 0) + r.sum)); continue; }
    const k = orgKind(r.organization);
    f.in[k] = r2(f.in[k] + r.sum);
    for (const t of ["vat", "novat", "unload", "cash"] as const) f.out[t] = r2(f.out[t] + r.out[t]);
  }
  return { organization: rows[0].organization, flows: f, budget: budgetOf(f), fx: [...fx].map(([currency, sum]) => ({ currency, sum })), actOn: rows.find((r) => r.actOn)?.actOn ?? null };
}

/** Оплати клієнта з 1С по угоді: за організацією; валюта — окремо. */
export interface PaidBlock { vat: number; novat: number; cash: number; total: number; fx: { currency: string; sum: number }[]; lastOn: string | null }
export function paidBlock(rows: readonly Pick<OnecPayment, "organization" | "sum" | "currency" | "paidOn">[]): PaidBlock | null {
  if (!rows.length) return null;
  const p = { vat: 0, novat: 0, cash: 0 };
  const fx = new Map<string, number>();
  for (const r of rows) {
    if (!isUah(r.currency)) { fx.set(r.currency, r2((fx.get(r.currency) ?? 0) + r.sum)); continue; }
    const k = orgKind(r.organization);
    p[k] = r2(p[k] + r.sum);
  }
  const last = rows.map((r) => r.paidOn).filter((x): x is string => !!x).sort().pop() ?? null;
  return { ...p, total: r2(p.vat + p.novat + p.cash), fx: [...fx].map(([currency, sum]) => ({ currency, sum })), lastOn: last };
}

/**
 * Бюджет угоди — `calcBudget_` скрипта Тетяни дослівно: прихід з ПДВ ×0,76 (×0,74, коли розхід лише готівкою), без ПДВ
 * ×0,94 (×0,92, коли безготівкового розходу немає), нал ×1; розхід з ПДВ ×0,76, без ПДВ ×0,94 при приході без ПДВ (інакше
 * ×1), «оплата на вигрузці» ×0, нал ×1; округлення до гривні. Усі нулі — `null` (у неї порожня клітинка).
 */
export function budgetOf(f: Flows): number | null {
  const [c1, c2, c3, c4, c5, c6, c7] = [f.in.vat, f.in.novat, f.in.cash, f.out.vat, f.out.novat, f.out.unload, f.out.cash];
  if (!c1 && !c2 && !c3 && !c4 && !c5 && !c6 && !c7) return null;
  const k1 = c7 !== 0 && c4 === 0 && c5 === 0 ? 0.74 : 0.76;
  const k2 = c4 === 0 && c5 === 0 ? 0.92 : 0.94;
  const k5 = c2 !== 0 && c5 !== 0 ? 0.94 : 1;
  return Math.round(c1 * k1 + c2 * k2 + c3 + c4 * 0.76 + c5 * k5 + c6 * 0 + c7);
}

/** «Плановий профіт PNL» (колонка AU): прихід 1С + розхід 1С без «оплати на вигрузці». */
export const planPnl = (f: Flows): number => r2(f.in.vat + f.in.novat + f.in.cash + f.out.vat + f.out.novat + f.out.cash);

/** Поля Kommo «Приход N» / «Приход N Тип оплаты» і «Расход N» / «Расход N Тип оплаты» (id заміряно через API 23.10.2026). */
export const KOMMO_IN_SLOTS = [[2097627, 2097629], [2097683, 2097631], [2097685, 2097633], [2097687, 2097635], [2097689, 2097637]] as const;
export const KOMMO_OUT_SLOTS = [[2097661, 2097651], [2097663, 2097653], [2097665, 2097655], [2097667, 2097657], [2097669, 2097659]] as const;
/** Kommo-блок (L–R): слоти за «Тип оплаты»; слот без відомого типу (напр. валютний) — у `untyped`, не в колонки. */
export function kommoFlows(get: (fieldId: number) => string | null | undefined): Flows & { untyped: number } {
  const f = emptyFlows();
  let untyped = 0;
  for (const [a, t] of KOMMO_IN_SLOTS) {
    const v = num(get(a)); if (!v) continue;
    const k = TYPE_IN[String(get(t) ?? "").trim()];
    if (k) f.in[k] = r2(f.in[k] + v); else untyped++;
  }
  for (const [a, t] of KOMMO_OUT_SLOTS) {
    const v = num(get(a)); if (!v) continue;
    const k = TYPE_OUT[String(get(t) ?? "").trim()];
    if (k) f.out[k] = r2(f.out[k] - v); else untyped++;
  }
  return { ...f, untyped };
}
