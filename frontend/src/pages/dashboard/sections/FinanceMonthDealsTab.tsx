import { Fragment, useMemo, useState } from "react";
import type { MRDeal, MRManager } from "../../../api";
import {
  MUTED, money, dmy, stamp, ymName, pill, BLOCKS, BLOCK_BG, COLS, useBlocks, kommoVs1c, overrideLabel, useMonthResult, excelOf, decisions,
  MonthSwitch, SourcesNote, type Ask, type Toast, type Col, type Block,
} from "./financeMonthShared";

/**
 * 📒 «УГОДИ МІСЯЦЯ» (#5583, 26.10.2026; Роман: «окремою таблицею всі угоди по кожному менеджеру, як окрему вкладку»).
 * Одна таблиця всіх угод місяця — як вкладка «Сделки» таблиці Тетяни, — згрупована за тим, хто закривав: заголовок групи
 * з числами СЕРВЕРА (ті самі, що в «Результаті місяця»), угоди, підсумок групи. Фільтри (менеджер, на перевірці, мінусові,
 * з рішенням, Kommo ≠ 1С, без 1С), пошук за угодою чи клієнтом, блоки Kommo / 1С / Оплати згортаються; шапка й колонка
 * угоди закріплені. Рішення — прямо в рядку. Дані — той самий `GET /finance/month-result`, що й зведення.
 */
type Flag = "review" | "minus" | "decided" | "mismatch" | "no1c";
const FLAGS: [Flag, string, (d: MRDeal) => boolean][] = [
  ["review", "На перевірці", (d) => d.included && d.checks.length > 0],
  ["minus", "Мінусові", (d) => d.included && (d.isMinus || d.profit < 0)],
  ["decided", "З рішенням", (d) => !!d.override],
  ["mismatch", "Kommo ≠ 1С", kommoVs1c],
  ["no1c", "Без 1С", (d) => !d.onec],
];
const ROW1 = 30;
/** Напівпрозорий колір блоку поверх суцільного фону — інакше крізь закріплену шапку просвічують рядки. */
const solid = (c: string) => `linear-gradient(${c}, ${c}), var(--card-bg)`;
const TH: React.CSSProperties = { position: "sticky", top: 0, zIndex: 3, background: "var(--card-bg)" };
const STICKY_TH: React.CSSProperties = { ...TH, left: 0, zIndex: 4, minWidth: 210 };
const STICKY_TD: React.CSSProperties = { position: "sticky", left: 0, zIndex: 1, background: "var(--card-bg)", minWidth: 240, maxWidth: 300, boxShadow: "1px 0 0 var(--border)" };

/** Менеджер у фільтрі: id з Kommo, `null` — без відповідального, `"all"` — усі. */
export type ManagerPick = number | null | "all";

export function FinanceMonthDealsTab({ ask, toast, ym, setYm, manager, setManager }: {
  ask: Ask; toast: Toast; ym: string; setYm: (ym: string) => void; manager: ManagerPick; setManager: (m: ManagerPick) => void;
}) {
  const { data, err, busy, pending, load } = useMonthResult(ym);
  const { blocks, toggleBlock } = useBlocks();
  const [flags, setFlags] = useState<Set<Flag>>(new Set());
  const [q, setQ] = useState("");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const { decide, undo } = decisions(ask, toast, () => load());

  const counts = useMemo(() => Object.fromEntries(FLAGS.map(([f, , t]) => [f, data?.deals.filter(t).length ?? 0])) as Record<Flag, number>, [data]);
  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const pass = (d: MRDeal) => (manager === "all" || d.closer === manager)
      && (!flags.size || FLAGS.some(([f, , t]) => flags.has(f) && t(d)))
      && (!needle || String(d.id).includes(needle) || (d.client ?? d.name).toLowerCase().includes(needle));
    return data.managers.map((m) => ({ m, all: data.deals.filter((d) => d.closer === m.kommoUserId) }))
      .map((g) => ({ ...g, shown: g.all.filter(pass) }))
      .filter((g) => g.shown.length > 0);
  }, [data, manager, flags, q]);

  if (err && !data) return <div className="chart-card"><b>Угоди місяця</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Рахую {ymName(ym)}{pending ? " — поля частини угод ще тягнуться з Kommo" : ""}…</p>;

  const cols = COLS.filter((c) => blocks[c.g] || c.main);
  const spans: { g: Block; n: number }[] = [];
  for (const c of cols) { const last = spans[spans.length - 1]; if (last && last.g === c.g) last.n++; else spans.push({ g: c.g, n: 1 }); }
  const firstOf = new Set(spans.map((s) => cols.find((c) => c.g === s.g)!.k));
  const edge = (k: string): React.CSSProperties | null => (firstOf.has(k) ? { borderLeft: "2px solid var(--border)" } : null);
  const width = 2 + cols.length + 4 + (data.canEdit ? 1 : 0);
  const shownAll = groups.flatMap((g) => g.shown);
  const link = (id: number) => <a href={`${data.kommoBase}/leads/detail/${id}`} target="_blank" rel="noreferrer">{id}</a>;
  const name = (id: number | null) => data.managers.find((m) => m.kommoUserId === id)?.name ?? (id == null ? "без відповідального" : `id ${id}`);
  const key = (m: MRManager) => String(m.kommoUserId);
  const toggleFlag = (f: Flag) => setFlags((x) => { const n = new Set(x); if (n.has(f)) n.delete(f); else n.add(f); return n; });
  const toggleFold = (k: string) => setFolded((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const cell = (c: Col, d: MRDeal) => {
    const v = c.v(d);
    const off = c.g === "onec" && c.main && kommoVs1c(d);
    return <td key={c.k} style={{ textAlign: c.text ? "left" : "right", whiteSpace: "nowrap", ...edge(c.k), ...(off ? { background: "rgba(217,119,6,0.14)" } : null), ...(c.main ? { fontWeight: 600 } : null) }}
      title={off ? `Бюджет Kommo ${money(d.price)} ≠ 1С ${money(d.onec!.budget!)}` : undefined}>
      {v == null || v === "" ? <span style={{ color: MUTED }}>—</span> : typeof v === "string" ? <span style={{ fontSize: 11.5 }}>{v}</span> : v === 0 ? <span style={{ color: MUTED }}>0</span> : money(v)}</td>;
  };
  const sums = (list: MRDeal[], label: React.ReactNode, strong?: boolean) => (
    <tr style={{ fontWeight: 700, background: strong ? "var(--surface-2, var(--bg))" : undefined }}>
      <td style={{ ...STICKY_TD, background: "var(--surface-2, var(--bg))" }}>{label}</td>
      <td />
      {cols.map((c) => <td key={c.k} style={{ textAlign: "right", whiteSpace: "nowrap", ...edge(c.k) }}>{c.text ? "" : money(list.reduce((a, d) => a + (Number(c.v(d)) || 0), 0))}</td>)}
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(list.reduce((a, d) => a + (d.planPnl ?? 0), 0))}</td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(list.reduce((a, d) => a + (d.included ? d.profit : 0), 0))}</td>
      <td /><td />{data.canEdit && <td />}
    </tr>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <MonthSwitch ym={ym} setYm={setYm} />
        <select className="hr-inp" style={{ marginLeft: 8, maxWidth: 260 }} aria-label="Менеджер" value={manager === "all" ? "all" : String(manager)}
          onChange={(e) => setManager(e.target.value === "all" ? "all" : e.target.value === "null" ? null : Number(e.target.value))}>
          <option value="all">Усі менеджери · {data.totals.deals}</option>
          {data.managers.map((m) => <option key={key(m)} value={key(m)}>{m.name} · {m.deals}</option>)}
        </select>
        <input className="hr-inp" style={{ width: 220 }} placeholder="Пошук: № угоди чи клієнт" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук угоди" />
        <span style={{ fontSize: 12, color: MUTED, marginLeft: "auto" }}>пораховано {stamp(data.computedAt)}</span>
        <button className="hr-btn" disabled={busy} onClick={() => load(true)}>{busy ? "Рахую…" : "↻ Оновити з Kommo"}</button>
        <button className="hr-btn" onClick={() => void excelOf(ym, toast)}>⬇ Excel</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: MUTED }}>Показати лише:</span>
        {FLAGS.map(([f, l]) => (
          <button key={f} className={`hr-btn ${flags.has(f) ? "p" : ""}`} style={{ padding: "2px 10px", fontSize: 12 }} aria-pressed={flags.has(f)} onClick={() => toggleFlag(f)} disabled={!counts[f] && !flags.has(f)}>{l} · {counts[f]}</button>
        ))}
        <span style={{ fontSize: 12, color: MUTED, marginLeft: 12 }}>Блоки:</span>
        {BLOCKS.map(([b, l]) => (
          <button key={b} className={`hr-btn ${blocks[b] ? "p" : ""}`} style={{ padding: "2px 10px", fontSize: 12 }} aria-pressed={blocks[b]} onClick={() => toggleBlock(b)}>{blocks[b] ? "▾" : "▸"} {l}</button>
        ))}
        <span style={{ fontSize: 12, color: MUTED, marginLeft: "auto" }}>показано {shownAll.length} з {data.deals.length}</span>
      </div>

      <div className="chart-card" style={{ padding: 10 }}>
        <SourcesNote data={data} />
        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 250px)", border: "1px solid var(--border)", borderRadius: 8 }}>
          <table className="hr-table mr-deals" style={{ width: "100%", fontSize: 12.5, margin: 0, borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr style={{ height: ROW1 }}>
                <th rowSpan={2} style={STICKY_TH}>Угода</th>
                <th rowSpan={2} style={TH}>Закрито</th>
                {spans.map((s) => <th key={s.g} colSpan={s.n} style={{ ...TH, textAlign: "left", background: solid(BLOCK_BG[s.g]), borderLeft: "2px solid var(--border)" }}>{BLOCKS.find((b) => b[0] === s.g)![1]}</th>)}
                <th rowSpan={2} style={{ ...TH, textAlign: "right" }} title="Прихід 1С + розхід 1С без «оплати на вигрузці» — колонка «Плановий профіт PNL»">Плановий PNL</th>
                <th rowSpan={2} style={{ ...TH, textAlign: "right" }}>У результаті</th>
                <th rowSpan={2} style={TH}>Перевірити</th>
                <th rowSpan={2} style={TH}>Рішення</th>
                {data.canEdit && <th rowSpan={2} style={TH} />}
              </tr>
              <tr>{cols.map((c) => <th key={c.k} style={{ ...TH, top: ROW1, textAlign: c.text ? "left" : "right", ...edge(c.k), background: solid(BLOCK_BG[c.g]), fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" }}>{c.h}</th>)}</tr>
            </thead>
            <tbody>
              {groups.map(({ m, all, shown }) => {
                const k = key(m), shut = folded.has(k);
                return (
                  <Fragment key={k}>
                    <tr className="it" onClick={() => toggleFold(k)} aria-expanded={!shut} style={{ background: "var(--info-bg, rgba(37,99,235,0.06))" }}>
                      <td colSpan={width} style={{ padding: "6px 8px" }}>
                        <div style={{ position: "sticky", left: 8, display: "inline-flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                          <b>{shut ? "▸" : "▾"} {m.name}</b>{!m.active && <span style={{ fontSize: 11, color: MUTED }}>неактивний</span>}
                          <span style={{ fontSize: 12.5 }}>угод <b>{m.deals}</b> · результат <b>{money(m.result)}</b></span>
                          {m.review.n > 0 && <span style={{ fontSize: 12, color: "#b45309" }}>на перевірці {m.review.n}</span>}
                          {m.minus.n > 0 && <span style={{ fontSize: 12, color: "#dc2626" }}>мінусових {m.minus.n}</span>}
                          {shown.length !== all.length && <span style={{ fontSize: 12, color: MUTED }}>показано {shown.length} з {all.length}</span>}
                        </div>
                      </td>
                    </tr>
                    {!shut && shown.map((d) => (
                      <tr key={d.id} style={!d.included ? { color: MUTED } : d.checks.length ? { background: "rgba(217,119,6,0.06)" } : undefined}>
                        <td style={STICKY_TD}>
                          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={d.client ?? d.name}>
                            {link(d.id)}{d.isMinus && <span style={{ ...pill("rgba(220,38,38,0.12)", "#dc2626"), marginLeft: 6 }}>мінус</span>} <span style={{ fontSize: 11.5 }}>{d.client ?? d.name}</span>
                          </div>
                          {(d.paymentType || d.reassigned) && <div style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>
                            {d.paymentType}{d.reassigned && <span title="Відповідального змінили після закриття — угода рахується тому, хто закривав">{d.paymentType ? " · " : ""}зараз: {name(d.current).split(" ")[0]}</span>}
                          </div>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>{dmy(d.closedAt)}{d.closedMonth.slice(0, 7) !== ym && <div style={{ fontSize: 11, color: MUTED }}>з {ymName(d.closedMonth.slice(0, 7))}</div>}</td>
                        {cols.map((c) => cell(c, d))}
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.planPnl == null ? <span style={{ color: MUTED }}>—</span> : money(d.planPnl)}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.included ? <b>{money(d.profit)}</b> : "—"}</td>
                        <td style={{ minWidth: 220 }}>{d.checks.length ? d.checks.map((c) => <div key={c} style={{ color: "#b45309" }}>{c}</div>) : <span style={{ color: MUTED }}>—</span>}</td>
                        <td style={{ minWidth: 150 }}>{d.override ? <><span style={pill("rgba(37,99,235,0.10)", "#2563eb")}>{overrideLabel(d)}</span><div style={{ fontSize: 11, color: MUTED }}>{d.override.note}{d.override.setBy ? ` — ${d.override.setBy}` : ""}</div></> : <span style={{ color: MUTED }}>—</span>}</td>
                        {data.canEdit && <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="hr-btn" onClick={() => decide(d)}>{d.override ? "Змінити" : "Рішення…"}</button>
                          {d.override && <button className="hr-btn" style={{ marginLeft: 4 }} onClick={() => void undo(d)}>Повернути</button>}
                        </td>}
                      </tr>
                    ))}
                    {!shut && sums(shown, <>Разом · {m.name.split(" ")[0]} · {shown.length}</>)}
                  </Fragment>
                );
              })}
              {!groups.length && <tr><td colSpan={width} className="hr-muted" style={{ padding: 16 }}>{data.deals.length ? "Під фільтр не потрапила жодна угода." : "У цьому місяці немає успішних угод «Повного циклу»."}</td></tr>}
              {groups.length > 1 && sums(shownAll, <>Усього · {shownAll.length}</>, true)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
