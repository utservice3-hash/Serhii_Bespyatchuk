import { useEffect, useMemo, useState } from "react";
import { fetchStatsSummary, type StatsSummaryResp, type StatsTile, type StatsTeamRow } from "../../../api";
import { addDays, sundayOf, mondayOf, monthEnd, addMonth, ddmm } from "../periodRules";
import { TilesSkeleton, TableSkeleton } from "../Skeleton";

/**
 * 📊 ВЕРХ СТОРІНКИ «СТАТИСТИКИ» — ЦИФРИ ЗАМІСТЬ КЛУБКА ЛІНІЙ (ТЗ 28.09.2026, блоки 1–3; задачі 4603–4605, 4367).
 *
 * За 10 секунд: скільки зараз · добре чи погано (до плану й до ТАКОГО САМОГО відрізка минулого періоду) ·
 * хто з команд тягне вгору / вниз. Усі числа рахує сервер (`/statistics/summary`): плитки — ядро грошей і
 * ті самі плани, що на Звіті; фронт лише показує. Порівняння завжди однакової довжини: пн–сьогодні проти
 * пн–того самого дня минулого тижня, тож у понеділок жодна плитка не «падає» на 90%.
 */

const MUTED = "var(--text-muted)";
const fmtN = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
const fmtV = (n: number, unit: string) => (unit === "₴" ? `${fmtN(n)} ₴` : fmtN(n));
const dm = ddmm;
const DOW = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const dow = (s: string) => DOW[new Date(`${s}T00:00:00Z`).getUTCDay()];
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

/* 📅 Дати — СПІЛЬНИМ модулем `periodRules` (як Звіт і «Реклама»), а не власними копіями: саме так дві копії
   починали збігатись одна з одною, а не з правилом (гейт #395b). Тиждень — Пн–Нд. */
const shiftMonth = addMonth;

/** Колір від % ПЛАНУ, а не від Δ (ТЗ, блок 2, п.1). Без плану — нейтральний. */
export function planTone(pct: number | null): { bg: string; border: string; fg: string } {
  if (pct == null) return { bg: "var(--card-bg)", border: "var(--border)", fg: "var(--text)" };
  if (pct >= 100) return { bg: "rgba(22,163,74,0.07)", border: "rgba(22,163,74,0.45)", fg: "#15803d" };
  if (pct >= 80) return { bg: "rgba(217,119,6,0.07)", border: "rgba(217,119,6,0.45)", fg: "#b45309" };
  return { bg: "rgba(220,38,38,0.06)", border: "rgba(220,38,38,0.4)", fg: "#b91c1c" };
}

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span style={{ color: MUTED }}>—</span>;
  return <span style={{ color: v >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{v >= 0 ? "▲" : "▼"} {Math.abs(v).toFixed(1)}%</span>;
}

function TileCard({ t, cmpLabel }: { t: StatsTile; cmpLabel: string }) {
  const tone = planTone(t.planPct);
  return (
    <div style={{ background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 14, padding: "13px 15px" }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: MUTED }}>{t.label}</div>
      {/* 📐 Формула — видимим підписом, а не лише під ⓘ (ТЗ, блок 4, п.5). */}
      <div style={{ fontSize: 11, color: MUTED, marginTop: 2, lineHeight: 1.35 }}>{t.formula}</div>
      <div style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 2px" }}>{fmtV(t.now, t.unit)}</div>
      {t.plan != null ? (
        <div style={{ fontSize: 13 }}>
          план <b>{fmtV(t.plan, t.unit)}</b> · <b style={{ color: tone.fg }}>{t.planPct}%</b>
          {/* 📅 Тиждень через межу місяців (рішення Романа 02.10): план складається з двох місячних частин — видно, звідки
              число й чому воно інше, ніж «план тижня» на Звіті (там показана лише частина поточного місяця). */}
          {t.planParts && t.planParts.length > 1 && (
            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 1 }}
              title="Звіт ділить тиждень по місяцях і показує план частини поточного місяця; тут — увесь тиждень Пн–Нд. Автоплан — по частинах місяців; кожна ручна ціль тімліда рахується один раз (і та, що на весь тиждень, і дві окремі на частини).">
              = {t.planParts.map((p) => p.kind === "manual"
                ? `${fmtV(p.plan, t.unit)} (ручні цілі тижня)`
                : `${fmtV(p.plan, t.unit)} (автоплан ${dm(p.from)}–${dm(p.to)})`).join(" + ")}
            </div>
          )}
        </div>
      ) : <div style={{ fontSize: 12.5, color: MUTED }}>{t.planNote}</div>}
      <div style={{ fontSize: 12.5, marginTop: 3 }}>
        <Delta v={t.deltaPct} /> <span style={{ color: MUTED }}>до {cmpLabel} ({fmtV(t.prev, t.unit)})</span>
      </div>
      {t.sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{t.sub.label}: <b style={{ color: "var(--text)" }}>{fmtV(t.sub.value, t.unit)}</b></div>}
    </div>
  );
}

type SortKey = "rank" | "name" | "fact" | "plan" | "pct" | "deltaPct";

function TeamsTable({ rows, onPick, picked }: { rows: StatsTeamRow[]; onPick: (teamId: number) => void; picked: number | null }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = rows.filter((r) => r.archived).length;
  const sorted = useMemo(() => {
    const live = rows.filter((r) => showArchived || !r.archived);
    const val = (r: StatsTeamRow): number | string | null => sort.key === "name" ? r.name : sort.key === "rank" ? (r.rank || 999) : r[sort.key];
    return [...live].sort((a, b) => {
      const A = val(a), B = val(b);
      if (A == null && B == null) return 0;
      if (A == null) return 1;               // без плану / без Δ — завжди внизу, у будь-якому напрямку
      if (B == null) return -1;
      return (typeof A === "string" ? A.localeCompare(B as string) : (A as number) - (B as number)) * sort.dir;
    });
  }, [rows, sort, showArchived]);
  const th = (key: SortKey, label: string, right = false) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" || key === "rank" ? 1 : -1 }))}
      style={{ textAlign: right ? "right" : "left", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title="сортувати">{label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</th>
  );
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px", marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14 }}>Команди</b>
        <span style={{ fontSize: 12, color: MUTED }}>
          факт — отримані кошти, як на Звіті · клік по команді — її графік нижче
          {archivedCount > 0 && (
            <label style={{ marginLeft: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> показати архівні ({archivedCount})
            </label>
          )}
        </span>
      </div>
      <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
        <thead><tr>{th("rank", "Ранг")}{th("name", "Команда")}{th("fact", "Факт", true)}{th("plan", "План", true)}{th("pct", "% плану", true)}{th("deltaPct", "Δ до попер.", true)}</tr></thead>
        <tbody>
          {sorted.map((r) => {
            const tone = planTone(r.pct);
            return (
              <tr key={r.teamId} onClick={() => onPick(r.teamId)}
                style={{ cursor: "pointer", background: picked === r.teamId ? "rgba(47,111,219,0.08)" : undefined, opacity: r.archived ? 0.6 : 1 }}>
                <td>{r.archived ? <span style={{ color: MUTED }}>архів</span> : r.rank}</td>
                <td style={{ fontWeight: 700 }}>{r.name}</td>
                <td style={{ textAlign: "right" }}>{fmtN(r.fact)} ₴</td>
                <td style={{ textAlign: "right" }}>{r.plan != null ? `${fmtN(r.plan)} ₴` : <span style={{ color: MUTED }}>плану немає</span>}</td>
                <td style={{ textAlign: "right", fontWeight: 800, color: tone.fg }}>{r.pct != null ? `${r.pct}%` : "—"}</td>
                <td style={{ textAlign: "right" }}><Delta v={r.deltaPct} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StatisticsSummary({ today, onPickTeam, pickedTeam }: { today: string; onPickTeam: (teamId: number) => void; pickedTeam: number | null }) {
  /* ⏳ ПІД ЧАС ПЕРЕМИКАННЯ ПЕРІОДУ БЛОК НЕ ЗНИКАЄ (прохання Романа 02.10): попередні цифри лишаються
     приглушеними, поки вантажаться нові; назва періоду рахується з ВИБОРУ, а не з відповіді сервера. */
  const [loading, setLoading] = useState(true);
  const [gran, setGran] = useState<"week" | "month">("week");
  /** Кінець обраного періоду (неділя / останній день місяця); поточний клампиться до сьогодні сервером. */
  const [end, setEnd] = useState<string>(() => sundayOf(today));
  const [data, setData] = useState<StatsSummaryResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const anchor = end > today ? today : end;
  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    fetchStatsSummary({ gran, anchor })
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setLoading(false); setErr(e?.response?.data?.error ?? (e?.response?.status ? `сервер відповів ${e.response.status}` : "немає звʼязку з сервером")); } });
    return () => { alive = false; };
  }, [gran, anchor, nonce]);

  const setGranKeep = (g: "week" | "month") => { setGran(g); setEnd(g === "week" ? sundayOf(today) : monthEnd(today)); };
  const shift = (n: number) => setEnd((e) => (gran === "week" ? addDays(e, 7 * n) : monthEnd(shiftMonth(e, n))));
  const isCurrent = gran === "week" ? end === sundayOf(today) : end === monthEnd(today);

  /** Список періодів для вибору: 26 тижнів Пн–Нд або 18 місяців, найсвіжіший зверху. */
  const periodOptions = useMemo(() => {
    const out: { end: string; label: string }[] = [];
    if (gran === "week") {
      for (let i = 0; i < 26; i++) { const e = addDays(sundayOf(today), -7 * i); out.push({ end: e, label: `${dm(mondayOf(e))}–${dm(e)}${i === 0 ? " (цей)" : i === 1 ? " (минулий)" : ""}` }); }
    } else {
      for (let i = 0; i < 18; i++) { const e = monthEnd(shiftMonth(today, -i)); out.push({ end: e, label: `${MONTHS[Number(e.slice(5, 7)) - 1]} ${e.slice(0, 4)}` }); }
    }
    if (!out.some((o) => o.end === end)) out.push({ end, label: gran === "week" ? `${dm(mondayOf(end))}–${dm(end)}` : `${MONTHS[Number(end.slice(5, 7)) - 1]} ${end.slice(0, 4)}` });
    return out;
  }, [gran, today, end]);
  const title = gran === "week"
    ? `Тиждень ${dm(mondayOf(end))}–${dm(end)}`
    : `${MONTHS[Number(end.slice(5, 7)) - 1]} ${end.slice(0, 4)}`;
  const cmpLabel = data ? (data.complete
    ? (gran === "week" ? `минулого тижня` : `минулого місяця`)
    : `${dm(data.prev.from)}–${dm(data.prev.to)}`) : "";

  const btn = (on: boolean) => ({ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: "pointer", border: "none",
    background: on ? "#1f2330" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" } as const);
  const pill = { fontSize: 12.5, fontWeight: 700, padding: "6px 11px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" } as const;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 700 }}>Період:</span>
        <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
          <button style={btn(gran === "week")} onClick={() => setGranKeep("week")}>Тиждень</button>
          <button style={btn(gran === "month")} onClick={() => setGranKeep("month")}>Місяць</button>
        </div>
        <button style={pill} onClick={() => setEnd(gran === "week" ? sundayOf(today) : monthEnd(today))} disabled={isCurrent}>{gran === "week" ? "Цей тиждень" : "Цей місяць"}</button>
        <button style={pill} onClick={() => setEnd(gran === "week" ? addDays(sundayOf(today), -7) : monthEnd(shiftMonth(today, -1)))}>{gran === "week" ? "Минулий" : "Минулий"}</button>
        <button style={pill} onClick={() => shift(-1)} aria-label="попередній">‹</button>
        <b style={{ fontSize: 14, minWidth: 150, textAlign: "center" }}>{title}</b>
        <button style={pill} onClick={() => shift(1)} disabled={isCurrent} aria-label="наступний">›</button>
        {/* 4367 (ТЗ Юлії): «можна вибрати будь-який тиждень зі списку: 14.09–20.09, 07.09–13.09…» — список Пн–Нд
            (півроку тижнів) або місяців (півтора року), значення — кінець періоду. */}
        <label style={{ fontSize: 12.5, color: MUTED }}>
          {gran === "week" ? "тиждень:" : "місяць:"}{" "}
          <select value={end} onChange={(e) => setEnd(e.target.value)}
            style={{ padding: "5px 6px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13 }}>
            {periodOptions.map((o) => <option key={o.end} value={o.end}>{o.label}</option>)}
          </select>
        </label>
        {loading && data && <span style={{ fontSize: 12.5, color: MUTED }}>⏳ оновлюємо…</span>}
        {!loading && data && !data.complete && (
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309" }}>
            станом на {dm(data.asOf)} ({dow(data.asOf)}) · порівняння з {dm(data.prev.from)}–{dm(data.prev.to)}
          </span>
        )}
      </div>

      {err && (
        <div role="alert" style={{ padding: "10px 14px", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 12, color: "#b91c1c", fontSize: 13 }}>
          ⚠️ Не вдалося порахувати цифри: {err}. <button style={pill} onClick={() => setNonce((n) => n + 1)}>Повторити</button>
        </div>
      )}
      {!data && !err && (
        <>
          <TilesSkeleton n={4} />
          <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px", marginTop: 14 }}>
            <TableSkeleton rows={5} />
          </div>
        </>
      )}
      {data && (
        <div className={loading ? "is-refreshing" : undefined} aria-busy={loading}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12 }}>
            {data.tiles.map((t) => <TileCard key={t.key} t={t} cmpLabel={cmpLabel} />)}
          </div>
          {data.teams.length > 0 && <TeamsTable rows={data.teams} onPick={onPickTeam} picked={pickedTeam} />}
        </div>
      )}
    </div>
  );
}
