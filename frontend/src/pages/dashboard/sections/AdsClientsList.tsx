import { useEffect, useMemo, useRef, useState } from "react";
import type { AdsClient, LtvGroup } from "../../../api";
import { money, dayLabel, wrapName } from "./adsUi";
import {
  DEAL_STEPS, EMPTY_FILTER, activeFilterCount, filterAdsClients, summarizeAdsClients, typeOf, stateOf,
  type AdsCampFilter, type AdsClientFilter, type AdsClientStateKey, type AdsClientType,
} from "./adsClientFilter";

/**
 * 👥 СПИСОК «КЛІЄНТИ З РЕКЛАМИ · ЗА LTV» — дизайн варіант А (Роман 19.11.2026).
 *
 *  • Вкладки «Усі / Стали постійними / Працюють зараз / Постійні, не замовляють» — як були (#8704), лише з лічильниками-бейджами.
 *  • Фільтри-пігулки: «Угод від N», «Тип», «Кампанія», «Стан» + пошук (TOP Weekly 16.11, Сергій: «фільтр по кількості угод»).
 *    Правила — у чистому `adsClientFilter.ts` (гейт `#3318b`), тут лише верстка.
 *  • Підсумок над таблицею рахується по ПОКАЗАНИХ рядках — плитки й кампанії вище фільтр не рухає.
 *  • Назва клієнта — посилання на його картку в Kommo (компанія → контакт → угода, `core/adClientLinks.ts`, `#3318`).
 */
const nf = (v: number) => v.toLocaleString("uk-UA");
const LIST_MAX = 15;

const TYPE: Record<AdsClientType, { label: string; bg: string; fg: string }> = {
  vip: { label: "⚡ ВІП", bg: "var(--rpt-ok-bg, #ecfdf3)", fg: "var(--rpt-ok, #067647)" },
  regular: { label: "↻ Регулярний", bg: "rgba(37, 99, 235, .09)", fg: "var(--rpt-link, #1d4ed8)" },
  episodic: { label: "🌙 Епізодичний", bg: "var(--rpt-warn-bg, #fdf2e0)", fg: "var(--rpt-warn, #a06a08)" },
  unknown: { label: "ще без типу", bg: "var(--rpt-soft, #f6f5f3)", fg: "var(--rpt-muted, #8a8f98)" },
  once: { label: "разовий", bg: "transparent", fg: "var(--rpt-muted, #8a8f98)" },
};
const TYPE_KEYS: AdsClientType[] = ["vip", "regular", "episodic", "unknown", "once"];
const STATE: Record<AdsClientStateKey, { label: string; dot: string; ring: string }> = {
  active: { label: "працює", dot: "#17b26a", ring: "rgba(23, 178, 106, .18)" },
  sleeping: { label: "сплячий", dot: "#f79009", ring: "rgba(247, 144, 9, .18)" },
  lost: { label: "втрачений", dot: "#a3a7ae", ring: "rgba(163, 167, 174, .2)" },
  none: { label: "стан невідомий", dot: "transparent", ring: "var(--rpt-line, #e8e6e3)" },
};
const STATE_KEYS: AdsClientStateKey[] = ["active", "sleeping", "lost", "none"];

type Chip = "all" | "rep" | "act" | "rs";
const CHIP: Record<Chip, { label: string; test: (c: AdsClient) => boolean }> = {
  all: { label: "Усі", test: () => true },
  rep: { label: "Стали постійними", test: (c) => c.qualified },
  act: { label: "Працюють зараз", test: (c) => c.state === "active" },
  rs: { label: "Постійні, не замовляють", test: (c) => c.group === "rs" },
};
type Pop = "deals" | "type" | "camp" | "state" | null;

/* :hover і :focus не живуть в інлайн-стилях — тому маленький скоуп `.adsc`. */
const CSS = `
.adsc-row:hover td { background: var(--rpt-soft, #fafaf8); }
.adsc-name { color: var(--rpt-ink, #16181d); font-weight: 650; text-decoration: none; }
.adsc-row:hover .adsc-name, .adsc-name:focus-visible { color: var(--rpt-link, #2563eb); text-decoration: underline; text-underline-offset: 3px; }
.adsc-kb { font-size: 11px; font-weight: 700; color: var(--rpt-link, #2563eb); background: rgba(37, 99, 235, .09); border-radius: 6px; padding: 2px 7px; opacity: 0; white-space: nowrap; }
.adsc-row:hover .adsc-kb, .adsc-name:focus-visible + .adsc-kb { opacity: 1; }
.adsc-pill { height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-radius: 999px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border: 1px dashed var(--rpt-line, #d6d3cf); background: transparent; color: var(--rpt-ink-soft, #4b5058); }
.adsc-pill[data-on="true"] { border: 1px solid rgba(37, 99, 235, .3); background: rgba(37, 99, 235, .08); color: var(--rpt-link, #1d4ed8); }
.adsc-opt { display: flex; width: 100%; align-items: center; gap: 8px; border: none; background: none; font: inherit; font-size: 13px; text-align: left;
  padding: 7px 10px; border-radius: 8px; cursor: pointer; color: var(--rpt-ink, #16181d); }
.adsc-opt:hover { background: var(--rpt-soft, #f6f5f3); }
.adsc-opt[aria-pressed="true"] { font-weight: 700; background: var(--rpt-soft, #f6f5f3); }
`;
const POP: React.CSSProperties = {
  position: "absolute", top: 40, left: 0, zIndex: 20, minWidth: 230, maxHeight: 340, overflowY: "auto", padding: 8,
  background: "var(--rpt-card, #fff)", border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 12,
  boxShadow: "0 12px 32px -8px rgba(16, 24, 40, .18)",
};
const TH: React.CSSProperties = { fontSize: 11.5, fontWeight: 650, color: "var(--rpt-muted, #8a8f98)", textAlign: "left", padding: "12px 16px",
  borderBottom: "1px solid var(--rpt-line, #eeece9)", whiteSpace: "nowrap" };
const TD: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid var(--rpt-line, #f2f1ef)", verticalAlign: "middle", fontSize: 14 };
const NUM: React.CSSProperties = { ...TD, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const SUB: React.CSSProperties = { fontSize: 12.5, color: "var(--rpt-muted, #8a8f98)", marginTop: 3 };

export function AdsClientsList({ clients, campaigns, group, groupLabel, onClearGroup }: {
  clients: AdsClient[]; campaigns: string[]; group: LtvGroup | null; groupLabel: string | null; onClearGroup: () => void;
}) {
  const [chip, setChip] = useState<Chip>("rep");
  const [f, setF] = useState<AdsClientFilter>(EMPTY_FILTER);
  const [pop, setPop] = useState<Pop>(null);
  const [showAll, setShowAll] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setShowAll(false); }, [group, chip, f]);
  useEffect(() => {
    if (!pop) return;
    const close = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setPop(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [pop]);

  const base = useMemo(() => clients.filter((c) => (group ? c.group === group : CHIP[chip].test(c))), [clients, group, chip]);
  const list = useMemo(() => filterAdsClients(base, f).sort((a, b) => b.margin - a.margin), [base, f]);
  const sum = summarizeAdsClients(list);
  const shown = showAll ? list : list.slice(0, LIST_MAX);
  const maxLtv = list.reduce((m, c) => Math.max(m, c.margin), 0);
  const set = (p: Partial<AdsClientFilter>) => { setF((x) => ({ ...x, ...p })); setPop(null); };
  const nOn = activeFilterCount(f);

  const campLabel = (c: AdsCampFilter) => (c === null ? null : c === "tagged" ? "з міткою" : c === "untagged" ? "без мітки" : c.name);
  const pill = (key: Exclude<Pop, null>, label: string, value: string | null, clear: () => void, body: React.ReactNode) => (
    <span style={{ position: "relative" }}>
      <button type="button" className="adsc-pill" data-on={value !== null} aria-expanded={pop === key} onClick={() => setPop((p) => (p === key ? null : key))}>
        {value === null ? <>＋ {label}</> : <>{label}: <b style={{ fontWeight: 700, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</b></>}
        <span style={{ opacity: 0.55, fontSize: 10 }}>▾</span>
        {value !== null && <span role="button" aria-label={`прибрати фільтр ${label}`} onClick={(e) => { e.stopPropagation(); clear(); setPop(null); }}
          style={{ opacity: 0.6, marginLeft: 2 }}>✕</span>}
      </button>
      {pop === key && <div style={POP}>{body}</div>}
    </span>
  );
  const opt = (on: boolean, label: React.ReactNode, pick: () => void, n?: number) => (
    <button type="button" className="adsc-opt" aria-pressed={on} onClick={pick}>
      <span style={{ flex: 1 }}>{label}</span>{n !== undefined && <span style={{ color: "var(--rpt-muted, #8a8f98)", fontSize: 12 }}>{nf(n)}</span>}
    </button>
  );
  // Лічильники в меню — ТИМ САМИМ фільтром, що й список (розкриття не сперечається з числом).
  const countWith = (p: Partial<AdsClientFilter>) => filterAdsClients(base, { ...EMPTY_FILTER, ...p }).length;

  return (
    <div style={{ background: "var(--rpt-card, #fff)", border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 18,
                  boxShadow: "0 1px 2px rgba(16, 24, 40, .04), 0 8px 24px -12px rgba(16, 24, 40, .08)" }}>
      <style>{CSS}</style>
      {/* Шапка: назва + пошук */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "22px 24px 0" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 750, letterSpacing: "-.3px" }}>
            {group ? <>Клієнти з реклами · {groupLabel}</> : "Клієнти з реклами"}
            {group && <button type="button" onClick={onClearGroup}
              style={{ all: "unset", cursor: "pointer", marginLeft: 10, fontSize: 13, fontWeight: 600, color: "var(--rpt-link, #2563eb)" }}>× скинути групу</button>}
          </div>
          <div style={{ ...SUB, fontSize: 13, marginTop: 4 }}>Хто прийшов з реклами і скільки приніс · за LTV · клік по назві відкриває клієнта в Kommo</div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, width: 280, height: 38, border: "1px solid var(--rpt-line, #e8e6e3)",
                        borderRadius: 10, padding: "0 12px", background: "var(--rpt-soft, #fbfaf9)" }}>
          <span aria-hidden style={{ color: "var(--rpt-muted, #8a8f98)" }}>🔍</span>
          <input value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} placeholder="Пошук клієнта" aria-label="Пошук клієнта"
            style={{ all: "unset", flex: 1, fontSize: 13.5, color: "var(--rpt-ink, #16181d)" }} />
          {f.q && <button type="button" onClick={() => setF((x) => ({ ...x, q: "" }))} aria-label="очистити пошук"
            style={{ all: "unset", cursor: "pointer", color: "var(--rpt-muted, #8a8f98)" }}>✕</button>}
        </label>
      </div>

      {/* Вкладки — ті самі чипи #8704; група складу (клік по смузі вище) їх підміняє */}
      {!group && (
        <div role="tablist" style={{ display: "flex", gap: 26, padding: "16px 24px 0", borderBottom: "1px solid var(--rpt-line, #eeece9)", flexWrap: "wrap" }}>
          {(Object.keys(CHIP) as Chip[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={chip === k} onClick={() => setChip(k)}
              style={{ all: "unset", cursor: "pointer", padding: "0 0 12px", marginBottom: -1, fontSize: 14, fontWeight: 600, display: "flex", gap: 8, alignItems: "center",
                       color: chip === k ? "var(--rpt-ink, #16181d)" : "var(--rpt-muted, #8a8f98)",
                       borderBottom: `2px solid ${chip === k ? "var(--rpt-ink, #16181d)" : "transparent"}` }}>
              {CHIP[k].label}
              <b style={{ fontSize: 12, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
                          background: chip === k ? "var(--rpt-ink, #16181d)" : "var(--rpt-soft, #f1f0ee)",
                          color: chip === k ? "var(--rpt-card, #fff)" : "var(--rpt-muted, #6b7079)" }}>{nf(clients.filter(CHIP[k].test).length)}</b>
            </button>
          ))}
        </div>
      )}

      {/* Фільтри-пігулки */}
      <div ref={barRef} style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 24px", flexWrap: "wrap", borderTop: group ? "1px solid var(--rpt-line, #eeece9)" : undefined, marginTop: group ? 16 : 0 }}>
        {pill("deals", "Угод", f.minDeals > 1 ? `від ${f.minDeals}` : null, () => setF((x) => ({ ...x, minDeals: 1 })), <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase", color: "var(--rpt-muted, #8a8f98)", margin: "4px 4px 8px" }}>Успішних угод від</div>
          <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--rpt-soft, #f4f3f1)" }}>
            {DEAL_STEPS.map((n) => (
              <button key={n} type="button" aria-pressed={f.minDeals === n} onClick={() => set({ minDeals: n })}
                style={{ flex: 1, border: "none", font: "inherit", fontSize: 13, fontWeight: 700, padding: "6px 0", borderRadius: 7, cursor: "pointer",
                         background: f.minDeals === n ? "var(--rpt-card, #fff)" : "transparent",
                         color: f.minDeals === n ? "var(--rpt-ink, #16181d)" : "var(--rpt-muted, #6b7079)",
                         boxShadow: f.minDeals === n ? "0 1px 2px rgba(0, 0, 0, .08)" : "none" }}>{n}</button>
            ))}
          </div>
          <div style={{ ...SUB, fontSize: 12, margin: "8px 4px 2px", lineHeight: 1.4 }}>
            {DEAL_STEPS.slice(1).map((n) => `від ${n} — ${nf(countWith({ minDeals: n }))}`).join(" · ")}
          </div>
        </>)}
        {pill("type", "Тип", f.type ? TYPE[f.type].label : null, () => setF((x) => ({ ...x, type: null })), <>
          {opt(f.type === null, "усі типи", () => set({ type: null }), base.length)}
          {TYPE_KEYS.map((k) => opt(f.type === k, TYPE[k].label, () => set({ type: k }), countWith({ type: k })))}
        </>)}
        {pill("camp", "Кампанія", campLabel(f.camp), () => setF((x) => ({ ...x, camp: null })), <>
          {opt(f.camp === null, "усі кампанії", () => set({ camp: null }), base.length)}
          {opt(f.camp === "tagged", "лише з міткою", () => set({ camp: "tagged" }), countWith({ camp: "tagged" }))}
          {opt(f.camp === "untagged", "без мітки кампанії", () => set({ camp: "untagged" }), countWith({ camp: "untagged" }))}
          <div style={{ height: 1, background: "var(--rpt-line, #eeece9)", margin: "6px 4px" }} />
          {campaigns.map((name) => opt(typeof f.camp === "object" && f.camp?.name === name, <span style={{ wordBreak: "break-all" }}>{name}</span>,
            () => set({ camp: { name } }), countWith({ camp: { name } })))}
        </>)}
        {pill("state", "Стан", f.state ? STATE[f.state].label : null, () => setF((x) => ({ ...x, state: null })), <>
          {opt(f.state === null, "будь-який стан", () => set({ state: null }), base.length)}
          {STATE_KEYS.map((k) => opt(f.state === k, STATE[k].label, () => set({ state: k }), countWith({ state: k })))}
        </>)}
        {(nOn > 0 || f.q) && <button type="button" onClick={() => { setF(EMPTY_FILTER); setPop(null); }}
          style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--rpt-muted, #8a8f98)", marginLeft: 4 }}>Скинути</button>}
      </div>

      {/* Підсумок по показаних */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", margin: "0 24px 6px", border: "1px solid var(--rpt-line, #eeece9)",
                    borderRadius: 12, background: "var(--rpt-soft, #fbfaf9)", overflow: "hidden" }}>
        {[["Показано", <>{nf(sum.clients)} <span style={{ fontSize: 13, fontWeight: 600, color: "var(--rpt-muted, #8a8f98)" }}>клієнтів</span></>],
          ["LTV разом", `${money(sum.margin)} ₴`], ["З повторних", `${money(sum.repeat)} ₴`],
          ["Працюють зараз", <span style={{ color: "var(--rpt-ok, #1a7f4b)" }}>{nf(sum.active)}</span>]].map(([l, v], i) => (
          <div key={i} style={{ padding: "10px 16px", borderLeft: i ? "1px solid var(--rpt-line, #eeece9)" : undefined }}>
            <div style={{ fontSize: 11.5, color: "var(--rpt-muted, #8a8f98)", fontWeight: 600 }}>{l}</div>
            <div style={{ fontSize: 18, fontWeight: 750, letterSpacing: "-.3px", marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead><tr>
            <th style={{ ...TH, paddingLeft: 24 }}>Клієнт</th><th style={TH}>Тип</th><th style={TH}>Стан</th>
            <th style={{ ...TH, textAlign: "right" }}>Угод</th>
            <th style={{ ...TH, textAlign: "right", color: "var(--rpt-ink, #16181d)" }}>LTV ↓</th>
            <th style={{ ...TH, textAlign: "right", paddingRight: 24 }} title="Маржа угод після першої оплаченої">З повторних</th>
          </tr></thead>
          <tbody>
            {shown.map((c) => {
              const t = TYPE[typeOf(c)], st = STATE[stateOf(c)];
              const repPct = c.margin > 0 ? Math.round((c.repeatMargin / c.margin) * 100) : null;
              return (
                <tr key={c.clientKey} className="adsc-row">
                  <td style={{ ...TD, paddingLeft: 24, maxWidth: 460 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {c.kommoUrl
                        ? <a className="adsc-name" href={c.kommoUrl} target="_blank" rel="noreferrer"
                            title={c.kommoKind === "company" ? "Відкрити компанію в Kommo" : c.kommoKind === "contact" ? "Відкрити контакт у Kommo" : "Відкрити угоду в Kommo"}>{c.name}</a>
                        : <span className="adsc-name" title="У CRM не знайдено ні компанії, ні контакту">{c.name}</span>}
                      {c.kommoUrl && <span className="adsc-kb" aria-hidden>Kommo ↗</span>}
                    </div>
                    <div style={SUB}>
                      {c.campaign ? <span style={{ color: "var(--rpt-ink-soft, #5b6068)" }}>{wrapName(c.campaign)}</span>
                        : <span style={{ fontStyle: "italic" }}>без мітки кампанії</span>}
                      <span style={{ margin: "0 6px" }}>·</span>з {dayLabel(c.firstLead)}.{c.firstLead.slice(2, 4)}
                    </div>
                  </td>
                  <td style={TD}><span style={{ fontSize: 12.5, fontWeight: 650, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap", background: t.bg, color: t.fg }}>{t.label}</span></td>
                  <td style={TD}><span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, whiteSpace: "nowrap",
                                                color: c.state ? "var(--rpt-ink-soft, #4b5058)" : "var(--rpt-muted, #8a8f98)" }}>
                    <i style={{ width: 8, height: 8, borderRadius: "50%", background: st.dot, boxShadow: `0 0 0 3px ${st.ring}` }} />{st.label}</span></td>
                  <td style={NUM}>{c.deals}</td>
                  <td style={NUM}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                      <b>{money(c.margin)} ₴</b>
                      <div style={{ width: 110, height: 5, borderRadius: 9, background: "var(--rpt-soft, #f1f0ee)", overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", borderRadius: 9, background: "var(--rpt-ink, #16181d)",
                                       width: `${maxLtv > 0 ? Math.max(0, (c.margin / maxLtv) * 100) : 0}%` }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ ...NUM, paddingRight: 24 }}>
                    {c.repeatMargin > 0 ? <>{money(c.repeatMargin)} ₴<div style={{ ...SUB, marginTop: 2, fontSize: 12 }}>{repPct}% LTV</div></>
                      : <span style={{ color: "var(--rpt-muted, #8a8f98)" }}>—</span>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={6} style={{ ...TD, paddingLeft: 24, color: "var(--rpt-muted, #8a8f98)" }}>
              Клієнтів під ці фільтри немає.{(nOn > 0 || f.q) && " Спробуйте прибрати частину фільтрів."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 24px", fontSize: 13, color: "var(--rpt-muted, #8a8f98)" }}>
        <span>{list.length ? `1–${nf(shown.length)} з ${nf(list.length)}` : ""}</span>
        {list.length > LIST_MAX && (
          <button type="button" onClick={() => setShowAll((v) => !v)}
            style={{ border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 9, padding: "7px 14px", font: "inherit", fontSize: 13, fontWeight: 650,
                     color: "var(--rpt-ink, #16181d)", background: "var(--rpt-card, #fff)", cursor: "pointer" }}>
            {showAll ? "Згорнути" : `Показати всіх · ${nf(list.length)}`}
          </button>
        )}
      </div>
    </div>
  );
}
