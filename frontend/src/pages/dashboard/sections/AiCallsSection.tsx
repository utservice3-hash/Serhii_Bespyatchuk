import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAiCalls, fetchAiCallsMeta, type AiCallsResp, type AiCallsMetaResp } from "../../../api";
import { AiCallDrawer } from "./AiCallDrawer";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { STATE_UI, TONE_COLOR, FILTERS, matchesFilter, mmss, aiDefaultPeriod, jobErrorIsCurrent, parseCallParam, withCallParam,
  type AiFilter, type AiCallState } from "../aiCallsView";

/**
 * 🎧 «ПЕРШИЙ ДОТИК · AI» — прохід 1, лише перегляд (рішення Романа 28.09.2026, макет — на ньому).
 *
 * Що є: перші розмови рекламних угод (правило — METRICS_GLOSSARY §15), витяг моделі з дослівними
 * цитатами, позначка «звірено з розшифровкою», факт Ringostat про наш наступний вихідний, стан
 * конвеєра й витрати. Чого немає свідомо: розбору тімліда, повернення угоди (П21), балу (після
 * калібрування), запису в Kommo. Повний текст розмови бачать лише адмін і КВП — сервер його
 * просто не віддає іншим, тож тут лише показуємо те, що прийшло.
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const usd = (v: number) => `$${v.toFixed(2)}`;

function StateChip({ state }: { state: AiCallState }) {
  const ui = STATE_UI[state];
  const c = TONE_COLOR[ui.tone];
  return <span title={ui.hint} style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{ui.label}</span>;
}

export function AiCallsSection() {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => aiDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<AiCallsResp | null>(null);
  const [meta, setMeta] = useState<AiCallsMetaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<AiFilter>("all");
  // Відкрита картка живе в адресі (`?call=`): посилання можна переслати, і воно відкриє ту саму картку.
  const [open, setOpenState] = useState<string | null>(() => parseCallParam(window.location.search));
  const setOpen = useCallback((uniqueid: string | null) => {
    setOpenState(uniqueid);
    window.history.replaceState(window.history.state, "", withCallParam(window.location.href, uniqueid));
  }, []);
  const closeCard = useCallback(() => setOpen(null), [setOpen]);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setD(null); setErr(null);
    fetchAiCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to]);
  useEffect(() => { fetchAiCallsMeta().then(setMeta).catch(() => setMeta(null)); }, []);

  const shown = useMemo(() => (d ? d.rows.filter((r) => matchesFilter(r, filter)) : []), [d, filter]);

  const navBar = <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  const drawer = open ? <AiCallDrawer uniqueid={open} onClose={closeCard} /> : null;
  if (err) return <div className="chart-card">{navBar}<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>{drawer}</div>;
  if (!d) return <div className="chart-card">{navBar}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>{drawer}</div>;

  const rows = d.rows;
  const done = rows.filter((r) => r.state === "done");
  const byState = new Map<AiCallState, number>();
  for (const r of rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
  const tile = (label: string, value: string, hint: string) => (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", minWidth: 130 }}>
      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", gap: 4, alignItems: "center" }}>{label}<InfoHint text={hint} /></div>
    </div>
  );
  const promises = done.reduce((s, r) => s + r.promises, 0);
  const withDeadline = done.reduce((s, r) => s + r.promisesWithDeadline, 0);
  const cell: React.CSSProperties = { padding: "7px 10px", verticalAlign: "top" };

  return (
    <>
      <div className="chart-card">
        {navBar}
        <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          Перший дотик · AI
          <InfoHint text="Перша розмова кожної рекламної угоди (будь-який напрямок, від 20 с), розпізнана по двох каналах і розібрана моделлю: ціна, заперечення, обіцянки й наступний крок із дослівними цитатами. Оцінки менеджера тут немає. Період — за датою створення угоди." />
        </h3>
        {meta && (
          <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-muted)" }}>
            Конвеєр: {meta.job?.lastSuccessAt ? `останній успішний запуск ${fmtTime(meta.job.lastSuccessAt)}` : "успішних запусків ще не було"}
            {meta.job?.lastError && (jobErrorIsCurrent(meta.job)
              ? <span style={{ color: "var(--danger, #b3261e)" }}> · остання помилка {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}: {meta.job.lastError}</span>
              : <span title={meta.job.lastError}> · остання помилка була {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}, після неї — успішні запуски</span>)}
            {" · "}витрати місяця: розпізнавання {usd(meta.spend.stt)}{meta.caps.stt != null ? ` з ${usd(meta.caps.stt)}` : " (стелю не задано)"},
            {" "}аналіз {usd(meta.spend.analysis)}{meta.caps.analysis != null ? ` з ${usd(meta.caps.analysis)}` : " (стелю не задано)"}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          {tile("перших розмов", rows.length.toLocaleString("uk-UA"), "Перші розмови рекламних угод, створених у періоді, у межах вашого доступу.")}
          {tile("проаналізовано", `${done.length.toLocaleString("uk-UA")}`, "Є розшифровка й витяг моделі. Решта — у черзі або з названою причиною (дивіться стан у рядку).")}
          {tile("обговорили ціну", done.filter((r) => r.priceDiscussed).length.toLocaleString("uk-UA"), "Серед проаналізованих.")}
          {tile("із запереченням", done.filter((r) => r.objections > 0).length.toLocaleString("uk-UA"), "Серед проаналізованих: клієнт висловив хоча б одне заперечення.")}
          {tile("обіцянок зі строком", `${String(withDeadline)} з ${String(promises)}`, "Обіцянки менеджера й клієнта; строк — як прозвучав у розмові. Чи виконано — окремий крок (П5).")}
        </div>
        {done.length < rows.length && (
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-muted)" }}>
            Ще не проаналізовано: {[...byState.entries()].filter(([s]) => s !== "done").map(([s, n]) => `${STATE_UI[s].label.toLowerCase()} — ${String(n)}`).join(", ")}.
          </p>
        )}
        {d.truncated && <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--warn-fg, #8a5a00)" }}>Показано перші 5 000 — звузьте період.</p>}
        <div role="group" aria-label="Фільтр" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
              style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "3px 12px", fontSize: 13, cursor: "pointer",
                background: filter === f.key ? "var(--accent-bg, #e8f0fb)" : "transparent", fontWeight: filter === f.key ? 600 : 400 }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chart-card" style={{ overflowX: "auto" }}>
        {shown.length === 0
          ? <p style={{ margin: 0, color: "var(--text-muted)" }}>{rows.length === 0 ? "У періоді немає перших розмов по рекламних угодах." : "Під цей фільтр розмов немає."}</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12.5 }}>
                  <th style={cell}>Розмова</th><th style={cell}>Менеджер</th><th style={cell}>Стан</th>
                  <th style={cell}>Про що</th><th style={cell}>Ціна</th><th style={cell}>Заперечення</th><th style={cell}>Обіцянки</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.uniqueid} tabIndex={0} aria-label={`Відкрити картку дзвінка ${fmtTime(r.calledAt)}`}
                    onClick={() => setOpen(r.uniqueid)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.uniqueid); }}
                    style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: open === r.uniqueid ? "var(--accent-bg, #e8f0fb)" : undefined }}>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {fmtTime(r.calledAt)}<div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec)}</div>
                      </td>
                      <td style={cell}>{r.managerName ?? "невідомий"}<div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.teamName ?? ""}</div></td>
                      <td style={cell}><StateChip state={r.state} /></td>
                      <td style={{ ...cell, maxWidth: 420 }}>{r.summary ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                      <td style={cell}>{r.priceDiscussed == null ? "—" : r.priceDiscussed ? "так" : "ні"}</td>
                      <td style={cell}>{r.state === "done" ? r.objections : "—"}</td>
                      <td style={cell}>{r.state === "done" ? `${String(r.promises)}${r.promises > r.promisesWithDeadline ? ` (без строку ${String(r.promises - r.promisesWithDeadline)})` : ""}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {drawer}
    </>
  );
}
