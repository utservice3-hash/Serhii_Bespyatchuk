import { useEffect, useMemo, useState } from "react";
import { fetchSecurityNoDeal, hiringError, type SecurityNoDeal, type SecurityNoDealDoc, type SecurityNoDealList } from "../../../api";

/**
 * 🛡 «БЕЗПЕКА» · ОПЕРАЦІЇ 1С БЕЗ УГОДИ (задача 11231; Роман 27.11.2026: «давай додамо вкладку безпека тільки для адмінів і оп
 * дира, де будемо це рахувати, роби, зроби гарний інтерфейс»).
 *
 * Три плитки = три списки документів 1С, у яких не вказано угоду CRM: реалізації, оплати клієнтів, неоплачені рахунки.
 * Числа плиток рахує сервер із тих самих рядків, що лежать у списку (`core/securityNoDeal.ts`, гейт `#11248`); тут — лише
 * вигляд: згортання за контрагентом, місяць, пошук. Фільтр звужує СПИСОК і рядок «показано», плитка лишається повною —
 * інакше головне число екрана змінювалось би від пошуку.
 * ⚠️ Валюта ніде не додається до гривні: у валютного документа сума стоїть зі своєю валютою, у підсумках — окремим рядком.
 * ⚠️ Порожній список до першого синку — це «ще не знаємо», і екран каже саме так (знімок пишеться щогодини о :45).
 */
const LISTS: { key: SecurityNoDealList; title: string; doc: string; hint: string }[] = [
  { key: "invoice", title: "Реалізації без угоди", doc: "Реалізація", hint: "Документи реалізації 1С, де не вказано угоду CRM" },
  { key: "payment", title: "Оплати без угоди", doc: "Оплата", hint: "Надходження грошей у 1С, де не вказано угоду CRM" },
  { key: "unpaid", title: "Неоплачені рахунки без угоди", doc: "Рахунок", hint: "Виставлені й досі не оплачені рахунки 1С без угоди CRM; сума — залишок до оплати" },
];
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

export function SecuritySection() {
  const [data, setData] = useState<SecurityNoDeal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<SecurityNoDealList>("payment");
  const [grouped, setGrouped] = useState(true);
  const [onlyUnnamed, setOnlyUnnamed] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Довгий список (199 оплат без назви контрагента) розгортаємо порцією: решта — кнопкою, і кнопка називає, скільки сховано.
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => { fetchSecurityNoDeal().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(hiringError(e))); }, []);
  // Інший список — інші контрагенти й місяці: розгорнуті групи й місяць попереднього списку тут нічого не означають.
  useEffect(() => { setOpen(new Set()); setFull(new Set()); setMonth(null); }, [list]);

  const meta = LISTS.find((l) => l.key === list)!;
  const all = data?.lists[list].docs ?? [];
  const needle = q.trim().toLowerCase();
  // Місяць НЕ входить у базу стовпчиків: стовпчики показують увесь список, а вибраний місяць лише підсвічено.
  const base = useMemo(() => all.filter((d) => (!onlyUnnamed || !d.kontragent)
    && (!needle || [d.kontragent, d.comment, d.number, d.organization, d.edrpou, d.dealRaw, d.manager].some((v) => v?.toLowerCase().includes(needle)))),
  [all, onlyUnnamed, needle]);
  const shown = useMemo(() => (month ? base.filter((d) => d.date?.slice(0, 7) === month) : base), [base, month]);

  const bars = useMemo(() => {
    if (!data) return [];
    const now = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
    const last = base.reduce((m, d) => (d.date && d.date.slice(0, 7) > m ? d.date.slice(0, 7) : m), now);
    const out: { ym: string; sum: number; docs: number }[] = [];
    for (let ym = data.from.slice(0, 7); ym <= last && out.length < 36;) {
      out.push({ ym, sum: 0, docs: 0 });
      const [y, m] = ym.split("-").map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
    const by = new Map(out.map((b) => [b.ym, b]));
    for (const d of base) { const b = d.date ? by.get(d.date.slice(0, 7)) : undefined; if (b) { b.docs++; if (isUah(d.currency)) b.sum += d.sum; } }
    return out;
  }, [base, data]);
  const barMax = Math.max(1, ...bars.map((b) => b.sum));

  const groups = useMemo(() => {
    const m = new Map<string, SecurityNoDealDoc[]>();
    for (const d of shown) { const k = d.kontragent || UNNAMED; const g = m.get(k); if (g) g.push(d); else m.set(k, [d]); }
    return [...m].map(([name, docs]) => {
      const dates = docs.map((d) => d.date).filter((x): x is string => !!x).sort();
      return { name, docs, sum: sumUah(docs), fx: fxLine(docs), from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
    }).sort((a, b) => b.sum - a.sum || b.docs.length - a.docs.length);
  }, [shown]);
  const groupsAll = useMemo(() => new Set(all.map((d) => d.kontragent || UNNAMED)).size, [all]);

  if (err) return <div style={{ ...card, color: "var(--danger)" }}>Не вдалося відкрити «Безпеку»: {err}</div>;
  if (!data) return <div style={{ ...card, color: "var(--text-muted)" }}>Завантаження…</div>;

  const state = list === "unpaid" ? data.unpaidState : data.snapshot;
  const year = data.from.slice(0, 4);
  const filtered = shown.length !== all.length;
  const showAll = (name: string) => setFull((f) => new Set(f).add(name));
  const toggle = (name: string) => setOpen((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const monthLabel = month ? `${MONTHS_FULL[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` : null;
  const shownFx = fxLine(shown);

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", fontSize: 22 }}>🛡 Безпека · операції 1С без угоди</h2>
      <p style={{ margin: "0 0 16px", color: "var(--text-muted)", maxWidth: 900, lineHeight: 1.5 }}>
        Документи 1С з {dmy(data.from)}, у яких не вказано угоду CRM. Гроші за ними не привʼязані до жодної угоди, тому їх не видно у звітах менеджерів.
        {data.snapshot.syncedAt ? ` Дані з 1С, оновлено ${at(data.snapshot.syncedAt)}.` : ""} Бачать лише адміністратор і операційний директор.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 14 }}>
        {LISTS.map((l) => {
          const t = data.lists[l.key].totals, on = l.key === list;
          const fxDocs = t.fx.reduce((n, f) => n + f.docs, 0);
          return (
            <button key={l.key} type="button" onClick={() => setList(l.key)} title={l.hint} aria-pressed={on}
              style={{ font: "inherit", textAlign: "left", cursor: "pointer", padding: "16px 18px", borderRadius: 14, background: "var(--card-bg)", color: "var(--text)",
                border: `1.5px solid ${on ? "var(--brand)" : "var(--border)"}`, boxShadow: on ? "0 0 0 3px rgba(197,20,28,0.10)" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--text-muted)", fontSize: 13 }}>
                <span>{l.title}</span><span style={{ whiteSpace: "nowrap" }}>{t.docs.toLocaleString("uk-UA")} док.</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, margin: "6px 0 4px", fontVariantNumeric: "tabular-nums" }}>{uah(t.uah)}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                {t.unnamed.docs > 0
                  ? <><b style={{ color: "var(--warn)" }}>{t.unnamed.docs.toLocaleString("uk-UA")} без назви контрагента</b> на {uah(t.unnamed.uah)}</>
                  : kontrWord(t.kontragents)}
                {fxDocs > 0 ? ` · ще ${fxDocs} у валюті` : ""}
              </div>
            </button>
          );
        })}
      </div>

      {state.error && (
        <div style={{ ...card, marginBottom: 12, background: "var(--warn-bg)", color: "var(--warn)" }}>
          Останній запис із 1С не вдався: {state.error}. Нижче останні вдалі дані{state.syncedAt ? ` (${at(state.syncedAt)})` : ""}.
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <button type="button" style={chip(grouped)} onClick={() => setGrouped(true)}>За контрагентом</button>
          <button type="button" style={chip(!grouped)} onClick={() => setGrouped(false)}>Усі документи</button>
          <button type="button" style={chip(onlyUnnamed)} onClick={() => setOnlyUnnamed((v) => !v)} aria-pressed={onlyUnnamed}>Лише без контрагента</button>
          <button type="button" style={chip(month == null)} onClick={() => setMonth(null)}>{monthLabel ? `${monthLabel} ✕` : `Увесь період з ${year}`}</button>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: контрагент, коментар, номер…" aria-label="Пошук у списку"
            style={{ font: "inherit", fontSize: 13, marginLeft: "auto", minWidth: 300, padding: "7px 12px", borderRadius: 10, border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)" }} />
        </div>

        {bars.length > 0 && all.length > 0 && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 86, marginBottom: 14 }} aria-label="Сума документів за місяцями, натисніть місяць, щоб відфільтрувати">
            {bars.map((b) => {
              const on = b.ym === month, mi = Number(b.ym.slice(5, 7)) - 1;
              return (
                <button key={b.ym} type="button" onClick={() => setMonth(on ? null : b.ym)} aria-pressed={on}
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
              <th style={th}>Контрагент / документ</th><th style={th}>Дата</th><th style={th}>Організація</th><th style={th}>У полі «угода»</th>
              <th style={th}>Коментар 1С</th><th style={{ ...th, textAlign: "right" }}>{list === "unpaid" ? "Залишок" : "Сума"}</th>
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
                <tr><td colSpan={6} style={{ ...td, color: "var(--text-muted)", padding: "22px 10px" }}>
                  {all.length > 0 ? "За цим фільтром документів немає."
                    : state.syncedAt ? `Документів без угоди з ${dmy(data.from)} немає.`
                      : "Дані ще не надходили: список зʼявиться після першого запису з 1С (щогодини о :45). Порожньо зараз не означає, що таких документів немає."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {all.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
            Показано {grouped ? `${kontrWord(groups.length)} з ${groupsAll.toLocaleString("uk-UA")}` : `${docsWord(shown.length)} з ${all.length.toLocaleString("uk-UA")}`}
            {" · "}Σ = {uah(sumUah(shown))}{filtered ? " (за фільтром)" : " (як на плитці)"}
            {shownFx ? ` · у валюті окремо: ${shownFx}` : ""}
            {list !== "unpaid" && ((data.snapshot.older ?? 0) > 0 || (data.snapshot.undated ?? 0) > 0) && (
              <div>Поза екраном лишились документи без угоди: до {year} року {(data.snapshot.older ?? 0).toLocaleString("uk-UA")}, без дати {(data.snapshot.undated ?? 0).toLocaleString("uk-UA")}.</div>
            )}
            <div>У звіти й показники ці документи не входять. Документ зникне звідси після наступного оновлення, щойно в 1С йому вкажуть угоду.</div>
          </div>
        )}
      </div>
    </div>
  );
}
