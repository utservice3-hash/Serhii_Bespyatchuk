import { useMemo } from "react";
import type { PzDealsResp, PzDealRowT, PzDealStateT } from "../../../api";

/**
 * 📋 «ТЕНДЕРИ PROZORRO»: детальна статистика й пул угод (TOP Weekly 12.11.2026, Сергій: «пул угод… відстежувати етапи — що в роботі,
 * що не в роботі»; макет погоджено Романом 13.11.2026). Усі числа — з `/api/prozorro/deals` (стан угоди ЗАРАЗ); тут лише показ.
 * Клік по плитці, етапу воронки, людині чи ніші відкриває ці угоди у вкладці «Угоди» з відповідним фільтром.
 */

export interface PoolFilter { state: "all" | "new" | "work" | "opr" | "passed" | "closed"; manager: string; niche: string; q: string; talk: boolean }
export const EMPTY_FILTER: PoolFilter = { state: "all", manager: "", niche: "", q: "", talk: false };

const C = { idle: "#B4B2A9", work: "#378ADD", ok: "#1D9E75", bad: "#E24B4A" };
const MUTED = "var(--text-muted)";
const fmt = (n: number) => n.toLocaleString("uk-UA");
const pct = (a: number, b: number) => (b ? Math.round((a * 100) / b) : 0);
const uah = (n: number | null) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} млн ₴` : `${fmt(Math.round(n / 1000))} тис. ₴`);
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const STATE_UI: Record<PzDealStateT, { label: string; bg: string; fg: string }> = {
  new: { label: "Тендер AI · не взято", bg: "var(--surface-2)", fg: MUTED },
  taken: { label: "Взято в роботу", bg: "var(--info-bg)", fg: "var(--info)" },
  opr: { label: "ОПР", bg: "var(--info-bg)", fg: "var(--info)" },
  passed: { label: "Передано менеджеру", bg: "var(--ok-bg)", fg: "var(--ok)" },
  auto: { label: "Авто поїхало", bg: "var(--ok-bg)", fg: "var(--ok)" },
  paid: { label: "Оплата", bg: "var(--ok-bg)", fg: "var(--ok)" },
  closed: { label: "Закрито", bg: "var(--danger-bg)", fg: "var(--danger)" },
};
const PASSED: PzDealStateT[] = ["passed", "auto", "paid"];

function Mix({ parts }: { parts: [number, string][] }) {
  const all = parts.reduce((a, [v]) => a + v, 0) || 1;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", minWidth: 110, background: "var(--surface-2)" }}>
      {parts.map(([v, c], i) => (v ? <i key={i} style={{ display: "block", width: `${(v * 100) / all}%`, background: c }} /> : null))}
    </div>
  );
}

export function ProzorroDealsStats({ data, onOpen }: { data: PzDealsResp; onOpen: (f: Partial<PoolFilter>) => void }) {
  const s = data.summary;
  const dub = s.reasons.find((r) => r.reason === "Дубль")?.n ?? 0;
  const freshPeople = s.people.filter((p) => p.fresh > 0);
  const kpis: { label: string; v: number; sub: string; color: string; f: Partial<PoolFilter> }[] = [
    { label: "Створено в Kommo", v: s.total, sub: "угоди в «Продзвін» · «Тендер AI»", color: C.work, f: {} },
    { label: "Не взято", v: s.fresh, sub: `${pct(s.fresh, s.total)}% · ніхто не почав`, color: "var(--warn)", f: { state: "new" } },
    { label: "У роботі", v: s.work, sub: "взято в роботу + ОПР", color: C.work, f: { state: "work" } },
    { label: "Передано менеджеру", v: s.passed, sub: "кваліфіковано", color: "var(--ok)", f: { state: "passed" } },
    { label: "Закрито", v: s.closed, sub: `${pct(s.closed, s.total)}% · без продажу`, color: "var(--danger)", f: { state: "closed" } },
    { label: "Розмова > 8 с", v: s.talk, sub: `${pct(s.talk, s.total)}% угод`, color: C.work, f: { talk: true } },
  ];
  const funnelFilter: (Partial<PoolFilter> | null)[] = [{}, { state: "work" }, { state: "opr" }, { state: "passed" }, null, null];
  const rmax = s.reasons[0]?.n ?? 1;
  return (
    <div style={{ display: "grid", gap: 16, marginBottom: 16 }}>
      <div className="kpi-grid">
        {kpis.map((k) => (
          <button key={k.label} type="button" className="kpi-card" onClick={() => onOpen(k.f)}
            style={{ borderLeft: `4px solid ${k.color}`, cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}>
            <span className="kpi-label">{k.label}</span><span className="kpi-value">{fmt(k.v)}</span>
            <span style={{ fontSize: 11, color: MUTED }}>{k.sub}</span>
          </button>
        ))}
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <h2 className="chart-title">Воронка тендерних угод</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {s.funnel.map((f, i) => {
              const prev = i ? s.funnel[i - 1].n : f.n;
              const go = funnelFilter[i];
              return (
                <div key={f.step} onClick={() => go && onOpen(go)} role={go ? "button" : undefined}
                  style={{ display: "grid", gridTemplateColumns: "150px 1fr 96px", gap: 10, alignItems: "center", cursor: go ? "pointer" : "default", fontSize: 13 }}>
                  <span>{f.step}</span>
                  <div style={{ height: 20, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                    <i style={{ display: "block", height: "100%", width: `${f.n && s.total ? Math.max(1.2, (f.n * 100) / s.total) : 0}%`, background: C.work, borderRadius: 4 }} />
                  </div>
                  <span style={{ textAlign: "right", fontSize: 12, color: MUTED }}><b style={{ color: "var(--text)", fontSize: 13 }}>{fmt(f.n)}</b> · {i ? `${pct(f.n, prev)}%` : "100%"}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>«Взято в роботу» й нижче — накопичено: угода на ОПР уже була взята. Авто й оплата — за угодою менеджера, створеною з кваліфікації.</div>
        </div>
        <div className="chart-card">
          <h2 className="chart-title">Потребує уваги</h2>
          <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <div style={{ borderLeft: "4px solid var(--warn)", background: "var(--warn-bg)", borderRadius: 8, padding: "10px 12px", display: "grid", gap: 4 }}>
              <b>{fmt(s.fresh)} {s.fresh === 1 ? "угоду" : "угод"} ніхто не взяв · {pct(s.fresh, s.total)}%</b>
              {freshPeople.length > 0
                ? <span>{freshPeople.map((p, i) => <span key={p.manager}>{i ? " · " : ""}{p.manager} — <b>{p.fresh}</b>{p.stale ? <span style={{ color: "var(--warn)", fontWeight: 700 }}> ({p.stale} довше доби)</span> : null}</span>)}</span>
                : <span style={{ color: MUTED }}>Усі угоди хтось уже взяв.</span>}
              <span style={{ fontSize: 12, color: MUTED }}>Угоди лежать у «Продзвоні» на «Тендер AI». Менеджери туди зазвичай не заходять — угоди на них майже невидимі.</span>
            </div>
            <div style={{ borderLeft: "4px solid var(--danger)", background: "var(--danger-bg)", borderRadius: 8, padding: "10px 12px", display: "grid", gap: 4 }}>
              <b>{fmt(dub)} дублів серед закритих</b>
              <span style={{ fontSize: 12, color: MUTED }}>Угоду створено компанії, у якої вже є угода в CRM.</span>
            </div>
            <div style={{ borderLeft: "4px solid var(--info)", background: "var(--info-bg)", borderRadius: 8, padding: "10px 12px", display: "grid", gap: 4 }}>
              <b>Розмова довше 8 с — у {fmt(s.talk)} із {fmt(s.total)} ({pct(s.talk, s.total)}%)</b>
              <span style={{ fontSize: 12, color: MUTED }}>Вихідний дзвінок на номер контакту після створення угоди. По людях — у таблиці нижче.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
          <h2 className="chart-title">Хто веде угоди</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: MUTED }}>
            {([["не взято", C.idle], ["у роботі", C.work], ["передано", C.ok], ["закрито", C.bad]] as const).map(([l, c]) => (
              <span key={l}><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: c, marginRight: 5, verticalAlign: -1 }} />{l}</span>))}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>Відповідальний</th><th>Команда</th><th style={{ textAlign: "right" }}>Усього</th><th style={{ textAlign: "right" }}>Не взято</th>
              <th style={{ textAlign: "right" }}>з них &gt; доби</th><th style={{ textAlign: "right" }}>У роботі</th><th style={{ textAlign: "right" }}>Передано</th>
              <th style={{ textAlign: "right" }}>Закрито</th><th style={{ textAlign: "right" }}>Розмова &gt; 8 с</th><th>Стан</th></tr></thead>
            <tbody>
              {s.people.map((p) => (
                <tr key={p.manager} onClick={() => onOpen({ manager: p.manager })} style={{ cursor: "pointer" }}>
                  <td><b>{p.manager}</b></td><td style={{ color: MUTED }}>{p.team ?? "—"}</td><td style={{ textAlign: "right" }}>{p.total}</td>
                  <td style={{ textAlign: "right", color: p.fresh ? "var(--warn)" : undefined, fontWeight: p.fresh ? 700 : undefined }}>{p.fresh}</td>
                  <td style={{ textAlign: "right", color: p.stale ? "var(--warn)" : undefined, fontWeight: p.stale ? 700 : undefined }}>{p.stale || "—"}</td>
                  <td style={{ textAlign: "right" }}>{p.work}</td><td style={{ textAlign: "right" }}>{p.passed || "—"}</td><td style={{ textAlign: "right" }}>{p.closed}</td>
                  <td style={{ textAlign: "right" }}>{pct(p.talk, p.total)}%</td>
                  <td><Mix parts={[[p.fresh, C.idle], [p.work, C.work], [p.passed, C.ok], [p.closed, C.bad]]} /></td>
                </tr>
              ))}
              {!s.people.length && <tr><td colSpan={10} style={{ color: MUTED }}>За цей період угод у Kommo не записано.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <h2 className="chart-title">Чому закривають · {fmt(s.closed)}</h2>
          {s.reasons.map((r) => (
            <div key={r.reason} style={{ display: "grid", gridTemplateColumns: "minmax(120px,200px) 1fr 36px", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 6 }}>
              <span>{r.reason}</span>
              <div style={{ height: 12, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}><i style={{ display: "block", height: "100%", width: `${(r.n * 100) / rmax}%`, background: C.bad }} /></div>
              <span style={{ textAlign: "right" }}>{r.n}</span>
            </div>
          ))}
          {!s.reasons.length && <div style={{ color: MUTED, fontSize: 13 }}>Закритих угод за період немає.</div>}
        </div>
        <div className="chart-card">
          <h2 className="chart-title">Ніші: скільки доходить до роботи</h2>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead><tr><th>Ніша</th><th style={{ textAlign: "right" }}>Створено</th><th style={{ textAlign: "right" }}>У роботі+</th><th style={{ textAlign: "right" }}>Закрито</th><th style={{ textAlign: "right" }}>% у роботу</th></tr></thead>
              <tbody>
                {s.niches.map((n) => (
                  <tr key={n.niche} onClick={() => onOpen({ niche: n.niche })} style={{ cursor: "pointer" }}>
                    <td>{n.niche}</td><td style={{ textAlign: "right" }}>{n.total}</td><td style={{ textAlign: "right" }}>{n.worked}</td><td style={{ textAlign: "right" }}>{n.closed}</td>
                    <td style={{ textAlign: "right" }}><b>{pct(n.worked, n.total)}%</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function matches(r: PzDealRowT, f: PoolFilter): boolean {
  if (f.talk && !r.talk) return false;
  if (f.state === "work" && r.state !== "taken" && r.state !== "opr") return false;
  if (f.state === "passed" && !PASSED.includes(r.state)) return false;
  if ((f.state === "new" || f.state === "opr" || f.state === "closed") && r.state !== f.state) return false;
  if (f.manager && (r.manager ?? "— без відповідального —") !== f.manager) return false;
  if (f.niche && (r.niche ?? "— без ніші —") !== f.niche) return false;
  if (f.q && !r.company.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

const STATES: [PoolFilter["state"], string][] = [["all", "Усі"], ["new", "Не взято"], ["work", "У роботі"], ["opr", "ОПР"], ["passed", "Передано"], ["closed", "Закрито"]];

export function ProzorroDealsPool({ data, filter, onFilter }: { data: PzDealsResp; filter: PoolFilter; onFilter: (f: PoolFilter) => void }) {
  const rows = useMemo(() => data.rows.filter((r) => matches(r, filter)), [data, filter]);
  const managers = useMemo(() => [...new Set(data.rows.map((r) => r.manager ?? "— без відповідального —"))].sort(), [data]);
  const niches = useMemo(() => [...new Set(data.rows.map((r) => r.niche ?? "— без ніші —"))].sort(), [data]);
  const sel = { border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 8, padding: "6px 10px", font: "inherit", fontSize: 13 } as const;
  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h2 className="chart-title">Пул тендерних угод</h2>
        <span style={{ fontSize: 12, color: MUTED }}>{fmt(rows.length)} з {fmt(data.rows.length)}{filter.talk ? " · лише з розмовою > 8 с" : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <div className="cl-tabs">
          {STATES.map(([k, l]) => (
            <button key={k} type="button" className="cl-tab" aria-pressed={filter.state === k && !filter.talk} onClick={() => onFilter({ ...filter, state: k, talk: false })}>{l}</button>))}
        </div>
        <select value={filter.manager} onChange={(e) => onFilter({ ...filter, manager: e.target.value })} aria-label="Відповідальний" style={sel}>
          <option value="">Усі відповідальні</option>{managers.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={filter.niche} onChange={(e) => onFilter({ ...filter, niche: e.target.value })} aria-label="Ніша" style={sel}>
          <option value="">Усі ніші</option>{niches.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input type="search" value={filter.q} onChange={(e) => onFilter({ ...filter, q: e.target.value })} placeholder="Компанія" aria-label="Пошук компанії" style={sel} />
        <button type="button" className="hr-btn" onClick={() => onFilter(EMPTY_FILTER)}>Скинути</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead><tr><th>Створено</th><th>Компанія</th><th style={{ textAlign: "right" }}>Сума тендера</th><th>Ніша</th><th>Відповідальний</th><th>Стан у Kommo</th><th>Розмова</th><th>Причина закриття</th><th>Kommo</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = STATE_UI[r.state];
              return (
                <tr key={r.leadId}>
                  <td>{ddmm(r.day)}</td><td>{r.company}</td><td style={{ textAlign: "right" }}>{uah(r.amount)}</td>
                  <td style={{ color: MUTED }}>{r.niche ?? "—"}</td><td>{r.manager ?? "— без відповідального —"}</td>
                  <td><span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap", background: st.bg, color: st.fg }}>{st.label}</span>
                    {r.state === "new" && r.ageDays >= 1 && <span style={{ fontSize: 11, color: "var(--warn)", marginLeft: 6 }}>{r.ageDays} дн.</span>}</td>
                  <td>{r.talk ? <span style={{ color: "var(--ok)", fontWeight: 600 }}>✓ була</span> : <span style={{ color: MUTED }}>—</span>}</td>
                  <td style={{ color: MUTED }}>{r.reason ?? ""}</td>
                  <td><a href={r.url} target="_blank" rel="noreferrer">{r.leadId} ↗</a></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={9} style={{ color: MUTED }}>Таких угод за період немає.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
