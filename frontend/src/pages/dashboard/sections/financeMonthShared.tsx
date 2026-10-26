import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMonthResult, setMonthResultOverride, downloadMonthResultXlsx, hiringError, type MonthResultData, type MRDeal } from "../../../api";

/**
 * 🏁 Спільне для «Результату місяця» і «Угод місяця» (#5583): завантаження з опитуванням (перший розрахунок буває
 * довшим за межу сервера), колонки угоди «як у таблиці Тетяни», рішення по угоді. Обидві вкладки беруть звідси — тож
 * число, підпис і рішення не можуть розійтися між ними.
 */
export type Toast = (text: string, opts?: { error?: boolean }) => void;
type Field = { id: string; label: string; value?: string; type?: "text" | "select"; options?: [string, string][]; placeholder?: string };
type DialogButton = { label: string; tone?: "p" | "dg"; run?: (v: Record<string, string>) => Promise<boolean | void> | boolean | void };
export type Ask = (d: { title: string; text?: string; fields?: Field[]; buttons: DialogButton[] }) => void;
const CANCEL: DialogButton = { label: "Скасувати" };

export const MUTED = "var(--text-muted)";
export const money = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");
export const kyivYm = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
export const shiftYm = (ym: string, n: number) => { const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
export const ymName = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("uk-UA", { month: "long", year: "numeric", timeZone: "UTC" });
export const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
export const stamp = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

/**
 * 📒 Колонки угоди «як у таблиці Тетяни» (прохід 2): блоки Kommo, 1С, оплати клієнтів з 1С — у порядку її «Сделки».
 * `main` — колонка, що лишається, коли блок згорнуто (бюджет / разом).
 */
export type Block = "kommo" | "onec" | "paid";
export const BLOCKS: [Block, string][] = [["kommo", "Kommo"], ["onec", "1С"], ["paid", "Оплати клієнтів (1С)"]];
export const BLOCK_BG: Record<Block, string> = { kommo: "rgba(37,99,235,0.07)", onec: "rgba(124,58,237,0.07)", paid: "rgba(22,163,74,0.07)" };
export type Col = { k: string; g: Block; h: string; v: (d: MRDeal) => number | string | null; main?: boolean; text?: boolean };
export const COLS: Col[] = [
  { k: "kb", g: "kommo", h: "Бюджет", v: (d) => d.price, main: true },
  { k: "ki1", g: "kommo", h: "Прих. з ПДВ", v: (d) => d.kommo?.in.vat ?? null },
  { k: "ki2", g: "kommo", h: "Прих. без ПДВ", v: (d) => d.kommo?.in.novat ?? null },
  { k: "ki3", g: "kommo", h: "Прих. нал", v: (d) => d.kommo?.in.cash ?? null },
  { k: "ko1", g: "kommo", h: "Розх. з ПДВ", v: (d) => d.kommo?.out.vat ?? null },
  { k: "ko2", g: "kommo", h: "Розх. без ПДВ", v: (d) => d.kommo?.out.novat ?? null },
  { k: "ko3", g: "kommo", h: "На вигрузці", v: (d) => d.kommo?.out.unload ?? null },
  { k: "ko4", g: "kommo", h: "Розх. нал", v: (d) => d.kommo?.out.cash ?? null },
  { k: "ob", g: "onec", h: "Бюджет 1С", v: (d) => d.onec?.budget ?? null, main: true },
  { k: "oo", g: "onec", h: "Організація", v: (d) => d.onec?.organization ?? null, text: true },
  { k: "oi1", g: "onec", h: "Прих. з ПДВ", v: (d) => d.onec?.flows.in.vat ?? null },
  { k: "oi2", g: "onec", h: "Прих. без ПДВ", v: (d) => d.onec?.flows.in.novat ?? null },
  { k: "oi3", g: "onec", h: "Прих. нал", v: (d) => d.onec?.flows.in.cash ?? null },
  { k: "oo1", g: "onec", h: "Розх. з ПДВ", v: (d) => d.onec?.flows.out.vat ?? null },
  { k: "oo2", g: "onec", h: "Розх. без ПДВ", v: (d) => d.onec?.flows.out.novat ?? null },
  { k: "oo3", g: "onec", h: "На вигрузці", v: (d) => d.onec?.flows.out.unload ?? null },
  { k: "oo4", g: "onec", h: "Розх. нал", v: (d) => d.onec?.flows.out.cash ?? null },
  { k: "p1", g: "paid", h: "з ПДВ", v: (d) => d.paid?.vat ?? null },
  { k: "p2", g: "paid", h: "без ПДВ", v: (d) => d.paid?.novat ?? null },
  { k: "p3", g: "paid", h: "нал", v: (d) => d.paid?.cash ?? null },
  { k: "pt", g: "paid", h: "Разом", v: (d) => d.paid?.total ?? null, main: true },
];
const LS_BLOCKS = "fin.monthResult.blocks";
const readBlocks = (): Record<Block, boolean> => {
  try { const v = JSON.parse(localStorage.getItem(LS_BLOCKS) ?? "null"); if (v && typeof v === "object") return { kommo: v.kommo !== false, onec: v.onec !== false, paid: v.paid !== false }; } catch { /* приватне вікно */ }
  return { kommo: true, onec: true, paid: true };
};
/** Згорнуті / розгорнуті блоки — памʼятаються в браузері. */
export function useBlocks() {
  const [blocks, setBlocks] = useState(readBlocks);
  const toggleBlock = (b: Block) => setBlocks((x) => { const n = { ...x, [b]: !x[b] }; try { localStorage.setItem(LS_BLOCKS, JSON.stringify(n)); } catch { /* приватне вікно */ } return n; });
  return { blocks, toggleBlock };
}
/** Бюджет 1С розходиться з Kommo (на 1 ₴ і більше) — підсвітка клітинки й фільтр «Kommo ≠ 1С». */
export const kommoVs1c = (d: MRDeal) => d.onec?.budget != null && Math.abs(d.price - d.onec.budget) >= 1;

/** Підпис рішення Тетяни — однаковий у таблиці й у підказці. */
export const overrideLabel = (d: MRDeal) => {
  const o = d.override; if (!o) return null;
  return o.action === "exclude" ? "не рахуємо" : o.action === "move" ? `перенесено в ${ymName(o.targetMonth!.slice(0, 7))}` : `свій профіт ${money(o.profit!)}`;
};

/**
 * Місяць із сервера. 202 `{ pending }` — сервер ще рахує (буває, коли полів угоди ще немає в базі), перепитуємо кожні 4 с.
 */
export function useMonthResult(ym: string) {
  const [data, setData] = useState<MonthResultData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const poll = useRef<number | undefined>(undefined);
  const load = useCallback((refresh = false) => {
    window.clearTimeout(poll.current);
    setBusy(true);
    fetchMonthResult(ym, refresh)
      .then((d) => {
        // Сервер ще рахує (перший розрахунок місяця довший за 20 с) — перепитуємо, поки не буде готово.
        if ("pending" in d) { setPending(true); poll.current = window.setTimeout(() => load(false), 4000); return; }
        setPending(false); setData(d); setErr(null); setBusy(false);
      })
      .catch((e) => { setPending(false); setErr(hiringError(e)); setBusy(false); });
  }, [ym]);
  useEffect(() => { setData(null); load(); return () => window.clearTimeout(poll.current); }, [load]);
  return { data, err, busy, pending, load };
}

/** Excel у форматі «09.26» + аркуш «Угоди». */
export async function excelOf(ym: string, toast: Toast) {
  try {
    const { blob, filename } = await downloadMonthResultXlsx(ym);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { toast(`Excel не завантажено: ${hiringError(e)}`, { error: true }); }
}

/** Рішення Тетяни по угоді: «не рахувати» / «в інший місяць» / «свій профіт» (примітка обовʼязкова) і «Повернути». */
export function decisions(ask: Ask, toast: Toast, reload: () => void) {
  const decide = (d: MRDeal) => ask({
    title: `Угода ${d.id} — рішення`,
    text: `${d.client ?? d.name} · бюджет ${money(d.price)} ₴ · закрито ${dmy(d.closedAt)}. Примітку видно в таблиці й в Excel.`,
    fields: [
      { id: "a", label: "Що зробити", type: "select", value: d.override?.action ?? "exclude", options: [["exclude", "Не рахувати в результаті"], ["move", "Рахувати в іншому місяці"], ["profit", "Рахувати свій профіт замість бюджету"]] },
      { id: "m", label: "Місяць (для «в іншому місяці»), РРРР-ММ", value: d.override?.targetMonth?.slice(0, 7) ?? shiftYm(d.closedMonth.slice(0, 7), 1), placeholder: "2026-10" },
      { id: "p", label: "Профіт, ₴ (для «свій профіт»; мінус можна)", value: d.override?.profit != null ? String(d.override.profit) : "", placeholder: "напр. 12500" },
      { id: "n", label: "Чому (обовʼязково)", value: d.override?.note ?? "", placeholder: "напр. оплата прийшла в жовтні" },
    ],
    buttons: [CANCEL, { label: "Зберегти", tone: "p", run: async (v) => {
      await setMonthResultOverride({ kommoId: d.id, action: v.a as "exclude" | "move" | "profit", targetMonth: v.m, profit: v.p, note: v.n });
      toast("Рішення збережено"); reload();
    } }],
  });
  const undo = async (d: MRDeal) => {
    try { await setMonthResultOverride({ kommoId: d.id, action: null }); toast("Рішення знято — угода рахується як у Kommo"); reload(); }
    catch (e) { toast(hiringError(e), { error: true }); }
  };
  return { decide, undo };
}

/** Перемикач місяця — однаковий в обох вкладках. */
export function MonthSwitch({ ym, setYm }: { ym: string; setYm: (ym: string) => void }) {
  return (
    <>
      <button className="hr-btn" onClick={() => setYm(shiftYm(ym, -1))} aria-label="Попередній місяць">◀</button>
      <b style={{ minWidth: 130, textAlign: "center" }}>{ymName(ym)}</b>
      <button className="hr-btn" onClick={() => setYm(shiftYm(ym, 1))} disabled={ym >= kyivYm()} aria-label="Наступний місяць">▶</button>
    </>
  );
}

/** Що за дані під числами: перепризначення, 1С, поля Kommo — «станом на». */
export function SourcesNote({ data }: { data: MonthResultData }) {
  return (
    <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
      Успішні угоди «Повного циклу», закриті в місяці (разом із мінусовими), сума бюджетів Kommo. Угода — тому, хто був відповідальним у момент закриття
      {data.eventsSince ? ` (перепризначення звірено ${stamp(data.eventsSince)})` : " (перепризначення ще не звірялись — рахується поточний відповідальний)"}.
      {" "}{data.onecSince ? `1С по угодах — станом на ${stamp(data.onecSince)}.` : "1С по угодах ще не завантажено — блоки 1С порожні."}
      {data.onecError && <span style={{ color: "#b45309" }}> Останній синк 1С не вдався: {data.onecError}</span>}
    </div>
  );
}
