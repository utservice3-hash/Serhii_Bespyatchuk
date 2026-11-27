import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSecurityNoDeal, hiringError, type SecurityNoDeal, type SecurityNoDealDoc, type SecurityNoDealList, type SecurityNoDealReason } from "../../../api";
import { DateRangeFilter, QuickPeriods } from "../../../components/DateRangeFilter";
import { HelpTip } from "./HelpTip";

/**
 * 🛡 «БЕЗПЕКА» · ДОКУМЕНТИ 1С БЕЗ УГОДИ (задача 11231; Роман 27.11.2026: «давай додамо вкладку безпека тільки для адмінів і оп
 * дира»; того ж дня: «таку саму шапку, як і у звіті… забери зайвий текст, додай знаки питання» і «нам потрібно бачити
 * рахунки, які не підкріплені до угоди, які міг виставити менеджер або бухгалтерія»).
 *
 * Три плитки = три списки документів 1С без угоди CRM: реалізації, оплати, неоплачені рахунки. Період і організацію
 * застосовує СЕРВЕР (`core/securityNoDeal.ts`): плитка рахується з тих самих рядків, що лежать у списку, тож під будь-яким
 * фільтром плитка = сума списку (гейти `#11248`, `#11260`). Тут — лише вигляд: згортання за контрагентом, сортування,
 * пошук. Пошук звужує список і рядок «показано», плитку не чіпає.
 * 🔴 На вкладці ЛИШЕ КЛІЄНТСЬКІ документи (рішення Романа 27.11.2026, картка «Лише клієнтські»): внутрішні організації,
 * надходження без платника, нульові й тестові сервер сюди не віддає. Перемикача «показати все» немає свідомо; під «?»
 * стоїть лише число відсіяних із причинами, щоб нова хвиля таких документів не лишилась непоміченою.
 * ⚠️ Валюта ніде не додається до гривні: у валютного документа сума стоїть зі своєю валютою, у підсумках — окремим рядком.
 * ⚠️ Порожній список до першого синку — це «ще не знаємо», і екран каже саме так (знімок пишеться щогодини о :45).
 * Пояснення живуть під «?» (`HelpTip`), а не абзацами на екрані.
 */
const LISTS: { key: SecurityNoDealList; title: string; doc: string; hint: string }[] = [
  { key: "invoice", title: "Реалізації без угоди", doc: "Реалізація", hint: "Документи реалізації 1С, де не вказано угоду CRM. Сума документа." },
  { key: "payment", title: "Оплати без угоди", doc: "Оплата", hint: "Надходження грошей у 1С, де не вказано угоду CRM. Ті самі клієнти можуть стояти і в реалізаціях: плитки не додавайте." },
  { key: "unpaid", title: "Неоплачені рахунки без угоди", doc: "Рахунок", hint: "Виставлені й досі не оплачені рахунки 1С без угоди CRM. Сума тут це залишок до оплати." },
];
const REASONS: Record<SecurityNoDealReason, string> = {
  internal: "внутрішні організації", unnamed: "без платника", zero: "із сумою 0", test: "тестові (перевірка інтеграції)",
};
const UNNAMED = "(без назви контрагента)";
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MONTHS_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

const isUah = (c: string) => /^(грн|uah)?$/i.test(c.trim());
const uah = (v: number) => `${Math.round(v).toLocaleString("uk-UA")} ₴`;
const amount = (d: SecurityNoDealDoc) => (isUah(d.currency) ? uah(d.sum) : `${d.sum.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ${d.currency}`);
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "без дати");
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const at = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};
const docsWord = (n: number) => `${n.toLocaleString("uk-UA")} ${plural(n, "документ", "документи", "документів")}`;
const kontrWord = (n: number) => `${n.toLocaleString("uk-UA")} ${plural(n, "контрагент", "контрагенти", "контрагентів")}`;
const sumUah = (docs: readonly SecurityNoDealDoc[]) => docs.reduce((s, d) => (isUah(d.currency) ? s + d.sum : s), 0);
const fxLine = (docs: readonly SecurityNoDealDoc[]): string | null => {
  const m = new Map<string, number>();
  for (const d of docs) if (!isUah(d.currency)) m.set(d.currency, (m.get(d.currency) ?? 0) + d.sum);
  return m.size ? [...m].map(([c, v]) => `${v.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ${c}`).join(" · ") : null;
};

const chip = (on: boolean): React.CSSProperties => ({
  font: "inherit", fontSize: 13, padding: "6px 14px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap",
  border: `1px solid ${on ? "var(--text)" : "var(--border-strong)"}`, background: on ? "var(--text)" : "var(--card-bg)", color: on ? "var(--card-bg)" : "var(--text)",
});
const card: React.CSSProperties = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: 18 };
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });
const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)",
  padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "9px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontSize: 13.5 };

/** Що стоїть у полі «угода» документа: порожньо, щось не схоже на номер угоди, або джерело цього поля не зберігає. */
function DealField({ raw }: { raw: string | null }) {
  if (raw == null) return <span style={{ color: "var(--text-muted)" }} title="У списку неоплачених рахунків 1С бачимо лише те, що 8-значного номера угоди немає">номера немає</span>;
  if (raw === "") return <span style={pill("var(--warn-bg)", "var(--warn)")} title="Поле «угода» в документі 1С порожнє">порожньо</span>;
  return <span style={pill("var(--danger-bg)", "var(--danger)")} title="У полі «угода» стоїть не 8-значний номер угоди CRM">{raw}</span>;
}

function DocRow({ d, label, nested }: { d: SecurityNoDealDoc; label: string; nested: boolean }) {
  return (
    <tr>
      <td style={{ ...td, paddingLeft: nested ? 30 : 10 }}>
        <div style={{ color: nested ? "var(--text-muted)" : "var(--text)" }}>
          {!nested && <b style={{ marginRight: 6 }}>{d.kontragent || UNNAMED}</b>}
          {label}{d.number ? ` № ${d.number.replace(/^0+(?=\d)/, "")}` : ""}
        </div>
        {(d.edrpou || d.manager) && (
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
            {[d.edrpou ? `код ${d.edrpou}` : null, d.manager].filter(Boolean).join(" · ")}
          </div>
        )}
      </td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>{dmy(d.date)}</td>
      <td style={td}>{d.organization ?? <span style={{ color: "var(--text-muted)" }}>не вказано</span>}</td>
      <td style={td}><DealField raw={d.dealRaw} /></td>
      <td style={{ ...td, color: d.comment ? "var(--text)" : "var(--text-muted)", maxWidth: 380 }}>{d.comment ?? "без коментаря"}</td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{amount(d)}</td>
    </tr>
  );
}

/** Скільки документів показуємо одразу в розгорнутій групі та в режимі «Усі документи»; решта — кнопкою з числом. */
const PAGE = 25;
const FLAT = "\u0000усі документи";
function MoreRow({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <tr><td colSpan={6} style={{ ...td, paddingLeft: 30 }}>
      <button type="button" onClick={onClick} style={{ font: "inherit", fontSize: 13, border: 0, background: "none", padding: 0, cursor: "pointer", color: "var(--info)", textDecoration: "underline" }}>
        Показати ще {docsWord(hidden)}
      </button>
    </td></tr>
  );
}

type SortBy = "sum" | "date";
interface Sort { by: SortBy; desc: boolean }
/** Заголовок колонки, за якою можна сортувати: клік по іншій колонці ставить її «більші / новіші зверху», повторний клік перевертає. */
function SortTh({ label, by, sort, onSort, right }: { label: string; by: SortBy; sort: Sort; onSort: (s: Sort) => void; right?: boolean }) {
  const on = sort.by === by;
  return (
    <th style={{ ...th, textAlign: right ? "right" : "left" }} aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => onSort({ by, desc: on ? !sort.desc : true })} title="Сортувати"
        style={{ font: "inherit", letterSpacing: "inherit", textTransform: "inherit", border: 0, background: "none", padding: 0, cursor: "pointer", color: on ? "var(--text)" : "var(--text-muted)" }}>
        {label} <span aria-hidden>{on ? (sort.desc ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>
  );
}
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };

export function SecuritySection() {
  const [data, setData] = useState<SecurityNoDeal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<SecurityNoDealList>("payment");
  // Шапка як у Звіті: швидкі періоди + довільний. «Весь час» тут = з початку року, з якого 1С віддає документи.
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [preset, setPreset] = useState<string | null>("alltime");
  const [orgs, setOrgs] = useState<readonly string[]>([]);
  const [grouped, setGrouped] = useState(true);
  const [sort, setSort] = useState<Sort>({ by: "sum", desc: true });
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Довгий список розгортаємо порцією: решта — кнопкою, і кнопка називає, скільки сховано.
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);

  useEffect(() => {
    // Відповідь на старіший запит не має перекрити новішу: швидкі кліки по періодах приходять не за порядком.
    const mine = ++seq.current;
    setBusy(true);
    fetchSecurityNoDeal({ from: range.from, to: range.to, orgs })
      .then((d) => { if (mine === seq.current) { setData(d); setErr(null); } })
      .catch((e) => { if (mine === seq.current) setErr(hiringError(e)); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [range.from, range.to, orgs]);
  // Інший список чи інший фільтр — інші контрагенти: розгорнуті групи попереднього набору тут нічого не означають.
  useEffect(() => { setOpen(new Set()); setFull(new Set()); }, [list, range.from, range.to, orgs]);

  const meta = LISTS.find((l) => l.key === list)!;
  const view = data?.lists[list];
  const all = view?.docs ?? [];
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const rows = needle ? all.filter((d) => [d.kontragent, d.comment, d.number, d.organization, d.edrpou, d.dealRaw, d.manager].some((v) => v?.toLowerCase().includes(needle))) : [...all];
    const dir = sort.desc ? -1 : 1;
    // Валютний документ у порядку за сумою йде після гривневих: його сума в іншій валюті, і ставити її в один ряд із гривнею не можна.
    const key = (d: SecurityNoDealDoc) => (isUah(d.currency) ? d.sum : -1);
    return rows.sort((a, b) => (sort.by === "sum" ? (key(a) - key(b)) * dir : (a.date ?? "").localeCompare(b.date ?? "") * dir) || (b.date ?? "").localeCompare(a.date ?? ""));
  }, [all, needle, sort]);

  const bars = useMemo(() => {
    if (!data || !view) return [];
    const now = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
    const last = view.months.reduce((m, b) => (b.ym > m ? b.ym : m), now);
    const by = new Map(view.months.map((b) => [b.ym, b]));
    const out: { ym: string; sum: number; docs: number }[] = [];
    for (let ym = data.from.slice(0, 7); ym <= last && out.length < 36;) {
      out.push({ ym, sum: by.get(ym)?.uah ?? 0, docs: by.get(ym)?.docs ?? 0 });
      const [y, m] = ym.split("-").map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
    return out;
  }, [data, view]);
  const barMax = Math.max(1, ...bars.map((b) => b.sum));

  const groups = useMemo(() => {
    const m = new Map<string, SecurityNoDealDoc[]>();
    for (const d of shown) { const k = d.kontragent || UNNAMED; const g = m.get(k); if (g) g.push(d); else m.set(k, [d]); }
    const dir = sort.desc ? -1 : 1;
    return [...m].map(([name, docs]) => {
      const dates = docs.map((d) => d.date).filter((x): x is string => !!x).sort();
      return { name, docs, sum: sumUah(docs), fx: fxLine(docs), from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
    }).sort((a, b) => (sort.by === "sum" ? (a.sum - b.sum) * dir : ((sort.desc ? a.to : a.from) ?? "").localeCompare((sort.desc ? b.to : b.from) ?? "") * dir) || b.docs.length - a.docs.length);
  }, [shown, sort]);

  if (err && !data) return <div style={{ ...card, color: "var(--danger)" }}>Не вдалося відкрити «Безпеку»: {err}</div>;
  if (!data || !view) return <div style={{ ...card, color: "var(--text-muted)" }}>Завантаження…</div>;

  const state = list === "unpaid" ? data.unpaidState : data.snapshot;
  const year = data.from.slice(0, 4);
  const showAll = (name: string) => setFull((f) => new Set(f).add(name));
  const toggle = (name: string) => setOpen((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const shownFx = fxLine(shown);
  const inRange = (ym: string) => (range.from || range.to) && (!range.from || monthEnd(ym) >= range.from) && (!range.to || `${ym}-01` <= range.to);
  const pickMonth = (ym: string) => {
    const one = range.from === `${ym}-01` && range.to === monthEnd(ym);
    setRange(one ? { from: "", to: "" } : { from: `${ym}-01`, to: monthEnd(ym) }); setPreset(one ? "alltime" : null);
  };
  // Вибрана організація лишається серед чипів, навіть коли в цьому списку її документів немає: інакше її не було б чим зняти.
  const orgChips = [...view.orgs, ...orgs.filter((o) => !view.orgs.some((x) => x.name === o)).map((name) => ({ name, docs: 0, uah: 0 }))];
  const toggleOrg = (name: string) => setOrgs((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));

  return (
    <div data-security>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22, display: "flex", alignItems: "center", gap: 8 }}>
          🛡 Безпека · документи 1С без угоди
          <HelpTip label="Що показує вкладка">
            Документи 1С з {dmy(data.from)}, у яких не вказано 8-значний номер угоди CRM. У звіти й показники вони не входять.
            Документ зникне звідси після наступного оновлення (щогодини о 45-й хвилині), щойно в 1С йому вкажуть угоду.
            Бачать лише адміністратор і операційний директор.
            {((data.snapshot.older ?? 0) > 0 || (data.snapshot.undated ?? 0) > 0) && (
              <> Поза екраном лишились документи без угоди: до {year} року {(data.snapshot.older ?? 0).toLocaleString("uk-UA")}, без дати {(data.snapshot.undated ?? 0).toLocaleString("uk-UA")}.</>
            )}
          </HelpTip>
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }} data-security-synced>
            {busy ? "оновлюю…" : state.syncedAt ? `дані 1С на ${at(state.syncedAt)}` : "даних з 1С ще не було"}
          </span>
          <DateRangeFilter value={range} onChange={(r) => { setRange(r); setPreset(null); }} />
        </div>
      </div>
      <QuickPeriods active={preset} onSelect={(id, r) => { setPreset(id); setRange(r); }} />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }} data-security-filters>
        <span style={{ fontSize: 13, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6 }} data-security-rule>
          Лише клієнтські документи
          <HelpTip label="Які документи тут показано">
            Є платник, організація не внутрішня («Облік сейфу», «Підрядник»), сума не нуль, платник не тестовий. Це рахунки й оплати клієнтів,
            які менеджер або бухгалтерія провели без угоди.
            {view.reasons.length > 0
              ? <> Не показано за цей період у списку «{meta.title}»: {view.scopes.other.docs.toLocaleString("uk-UA")} на {uah(view.scopes.other.uah)} ({view.reasons.map((r) => `${REASONS[r.reason]} ${r.docs.toLocaleString("uk-UA")} на ${uah(r.uah)}`).join("; ")}).</>
              : <> Відсіяних документів за цей період у списку «{meta.title}» немає.</>}
          </HelpTip>
        </span>
        <span aria-hidden style={{ width: 1, height: 22, background: "var(--border-strong)", margin: "0 4px" }} />
        <button type="button" style={chip(orgs.length === 0)} onClick={() => { if (orgs.length) setOrgs([]); }} aria-pressed={orgs.length === 0}>Усі організації</button>
        {orgChips.map((o) => (
          <button key={o.name} type="button" style={chip(orgs.includes(o.name))} onClick={() => toggleOrg(o.name)} aria-pressed={orgs.includes(o.name)}
            title={`${docsWord(o.docs)}, ${uah(o.uah)}`}>
            {o.name || "організацію не вказано"} · {o.docs.toLocaleString("uk-UA")}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 14 }}>
        {LISTS.map((l) => {
          const t = data.lists[l.key].totals, on = l.key === list;
          const fxDocs = t.fx.reduce((n, f) => n + f.docs, 0);
          return (
            <div key={l.key} role="button" tabIndex={0} aria-pressed={on} data-security-tile={l.key} onClick={() => setList(l.key)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setList(l.key); } }}
              style={{ textAlign: "left", cursor: "pointer", padding: "16px 18px", borderRadius: 14, background: "var(--card-bg)", color: "var(--text)",
                border: `1.5px solid ${on ? "var(--brand)" : "var(--border)"}`, boxShadow: on ? "0 0 0 3px rgba(197,20,28,0.10)" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 13 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{l.title}<HelpTip label={l.title}>{l.hint}</HelpTip></span>
                <span style={{ whiteSpace: "nowrap" }}>{t.docs.toLocaleString("uk-UA")} док.</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, margin: "6px 0 4px", fontVariantNumeric: "tabular-nums" }}>{uah(t.uah)}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                {t.unnamed.docs > 0
                  ? <><b style={{ color: "var(--warn)" }}>{t.unnamed.docs.toLocaleString("uk-UA")} без назви контрагента</b> на {uah(t.unnamed.uah)}</>
                  : kontrWord(t.kontragents)}
                {fxDocs > 0 ? ` · ще ${fxDocs} у валюті` : ""}
              </div>
            </div>
          );
        })}
      </div>

      {err && <div style={{ ...card, marginBottom: 12, color: "var(--danger)" }}>Не вдалося оновити список: {err}. На екрані попередня відповідь.</div>}
      {state.error && (
        <div style={{ ...card, marginBottom: 12, background: "var(--warn-bg)", color: "var(--warn)" }}>
          Останній запис із 1С не вдався: {state.error}. Нижче останні вдалі дані{state.syncedAt ? ` (${at(state.syncedAt)})` : ""}.
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <button type="button" style={chip(grouped)} onClick={() => setGrouped(true)}>За контрагентом</button>
          <button type="button" style={chip(!grouped)} onClick={() => setGrouped(false)}>Усі документи</button>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: контрагент, коментар, номер…" aria-label="Пошук у списку"
            style={{ font: "inherit", fontSize: 13, marginLeft: "auto", minWidth: 300, padding: "7px 12px", borderRadius: 10, border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)" }} />
        </div>

        {bars.length > 0 && view.all > 0 && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 86, marginBottom: 14 }} aria-label="Сума документів за місяцями, натисніть місяць, щоб поставити його періодом">
            {bars.map((b) => {
              const on = !!inRange(b.ym), mi = Number(b.ym.slice(5, 7)) - 1;
              return (
                <button key={b.ym} type="button" onClick={() => pickMonth(b.ym)} aria-pressed={on}
                  title={`${MONTHS_FULL[mi]} ${b.ym.slice(0, 4)}: ${docsWord(b.docs)}, ${uah(b.sum)}`}
                  style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 4, padding: 0, border: 0, background: "none", cursor: "pointer", font: "inherit" }}>
                  <span style={{ display: "block", borderRadius: 4, height: b.sum > 0 ? `${Math.max(4, Math.round((b.sum / barMax) * 64))}px` : b.docs > 0 ? "3px" : "1px",
                    background: on ? "var(--brand)" : b.docs > 0 ? "rgba(197,20,28,0.35)" : "var(--border)" }} />
                  <span style={{ fontSize: 11, color: on ? "var(--text)" : "var(--text-muted)", fontWeight: on ? 700 : 400 }}>{MONTHS[mi]}</span>
                </button>
              );
            })}
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Контрагент / документ</th><SortTh label="Дата" by="date" sort={sort} onSort={setSort} /><th style={th}>Організація</th><th style={th}>У полі «угода»</th>
              <th style={th}>Коментар 1С</th><SortTh label={list === "unpaid" ? "Залишок" : "Сума"} by="sum" sort={sort} onSort={setSort} right />
            </tr></thead>
            <tbody>
              {grouped && groups.map((g) => {
                const isOpen = open.has(g.name), unnamed = g.name === UNNAMED;
                return [
                  <tr key={g.name} onClick={() => toggle(g.name)} style={{ cursor: "pointer", background: "var(--surface-2)" }}>
                    <td style={{ ...td, fontWeight: 700 }}>
                      <button type="button" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); toggle(g.name); }}
                        style={{ font: "inherit", fontWeight: 700, border: 0, background: "none", padding: 0, cursor: "pointer", color: "var(--text)", textAlign: "left" }}>
                        <span aria-hidden style={{ display: "inline-block", width: 16 }}>{isOpen ? "▾" : "▸"}</span>{g.name}
                      </button>
                      <span style={{ ...pill(unnamed ? "var(--danger-bg)" : "var(--warn-bg)", unnamed ? "var(--danger)" : "var(--warn)"), marginLeft: 8 }}>{g.docs.length} док.</span>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-muted)" }}>{g.from ? (g.from === g.to ? dmy(g.from) : `${dm(g.from)} – ${dm(g.to!)}`) : "без дати"}</td>
                    <td style={td} colSpan={3} />
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {uah(g.sum)}{g.fx && <div style={{ fontSize: 11.5, fontWeight: 400, color: "var(--text-muted)" }}>+ {g.fx}</div>}
                    </td>
                  </tr>,
                  ...(isOpen ? (full.has(g.name) ? g.docs : g.docs.slice(0, PAGE)).map((d, i) => <DocRow key={`${g.name}·${i}`} d={d} label={meta.doc} nested />) : []),
                  ...(isOpen && !full.has(g.name) && g.docs.length > PAGE ? [<MoreRow key={`${g.name}·more`} hidden={g.docs.length - PAGE} onClick={() => showAll(g.name)} />] : []),
                ];
              })}
              {!grouped && (full.has(FLAT) ? shown : shown.slice(0, PAGE)).map((d, i) => <DocRow key={i} d={d} label={meta.doc} nested={false} />)}
              {!grouped && !full.has(FLAT) && shown.length > PAGE && <MoreRow hidden={shown.length - PAGE} onClick={() => showAll(FLAT)} />}
              {shown.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: "var(--text-muted)", padding: "22px 10px" }} data-security-empty>
                  {view.all > 0
                    ? "За цим фільтром клієнтських документів без угоди немає."
                    : state.syncedAt ? `Клієнтських документів без угоди з ${dmy(data.from)} немає.`
                      : "Дані ще не надходили: список зʼявиться після першого запису з 1С (щогодини о :45). Порожньо зараз не означає, що таких документів немає."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {all.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--text-muted)" }} data-security-shown>
            Показано {docsWord(shown.length)} з {all.length.toLocaleString("uk-UA")}{grouped ? `, ${kontrWord(groups.length)}` : ""}
            {" · "}Σ = {uah(sumUah(shown))}{needle ? " (за пошуком)" : " (як на плитці)"}
            {shownFx ? ` · у валюті окремо: ${shownFx}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
