import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchAiCalls, fetchAiCallCard, fetchAiCallsMeta,
  type AiCallsResp, type AiCallCardResp, type AiCallsMetaResp, type AiQuoted,
} from "../../../api";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { STATE_UI, TONE_COLOR, FILTERS, matchesFilter, speakerOf, mmss, afterLabel, aiDefaultPeriod,
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

function Quote({ q }: { q: AiQuoted }) {
  if (!q.quote.trim()) return null;
  return (
    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
      <q>{q.quote}</q>{" "}
      {q.quote_found === true && <span style={{ color: "var(--ok-fg, #1d6b3a)", fontSize: 12 }}>✓ звірено з розшифровкою</span>}
      {q.quote_found === false && <span style={{ color: "var(--danger, #b3261e)", fontSize: 12 }}>✗ такої фрази в розмові немає</span>}
    </div>
  );
}

function CallCard({ uniqueid }: { uniqueid: string }) {
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchAiCallCard(uniqueid)
      .then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [uniqueid]);
  if (err) return <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>;
  if (!c) return <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>;
  const r = c.result;
  const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "160px 1fr", gap: 10, padding: "4px 0" };
  const k: React.CSSProperties = { fontSize: 12.5, color: "var(--text-muted)", fontWeight: 600 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 4px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 13, color: "var(--text-muted)" }}>
        <StateChip state={c.row.state} />
        <span>тривалість запису {mmss(c.durationSec)}</span>
        <span>· {afterLabel(c.row.calledAt, c.nextOutboundAt)}</span>
        {c.dealUrls.map((d) => <a key={d.kommoId} href={d.url} target="_blank" rel="noreferrer">угода {d.kommoId} в Kommo ↗</a>)}
      </div>
      {c.row.failure && <div style={{ fontSize: 13, color: "var(--danger, #b3261e)" }}>Причина: {c.row.failure}</div>}
      {r && (
        <div>
          <div style={row}><span style={k}>Про що</span><span>{r.summary}</span></div>
          {r.client_request && <div style={row}><span style={k}>Запит</span><span>{r.client_request}</span></div>}
          <div style={row}><span style={k}>Ціна</span><span>{r.price.discussed ? "обговорили" : "не прозвучала"}<Quote q={r.price} /></span></div>
          {r.objections.map((o, i) => (
            <div key={`o${String(i)}`} style={row}><span style={{ ...k, color: "var(--danger, #b3261e)" }}>Заперечення</span><span>{o.what}<Quote q={o} /></span></div>
          ))}
          {r.promises.map((p, i) => (
            <div key={`p${String(i)}`} style={row}>
              <span style={k}>Обіцянка · {p.who === "manager" ? "менеджер" : "клієнт"}</span>
              <span>{p.what}{" "}
                <span style={{ fontSize: 12, padding: "0 6px", borderRadius: 4, background: p.deadline_text.trim() ? "var(--info-bg, #e8f0fb)" : "var(--warn-bg, #fff4dc)" }}>
                  {p.deadline_text.trim() ? `строк: ${p.deadline_text}` : "без строку"}
                </span>
                <Quote q={p} />
              </span>
            </div>
          ))}
          {r.next_step && <div style={row}><span style={k}>Далі</span><span>{r.next_step}</span></div>}
        </div>
      )}
      {c.transcriptHidden
        ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Повний текст розмови бачать адмін і КВП. Цитати вище — дослівні.</div>
        : c.turns && (
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>Розшифровка · {c.turns.length} реплік</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 420, overflow: "auto", marginTop: 6 }}>
              {c.turns.map((t, i) => {
                const who = speakerOf(t.channel, c.managerChannel);
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "44px 78px 1fr", gap: 8, fontSize: 13, padding: "2px 6px", borderRadius: 4,
                    background: who === "Менеджер" ? "var(--ok-bg, #eef6ea)" : "var(--muted-bg, #f6f3ea)" }}>
                    <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{mmss(t.start)}</span>
                    <b style={{ fontSize: 12.5 }}>{who}</b>
                    <span>{t.text}</span>
                  </div>
                );
              })}
            </div>
          </details>
        )}
    </div>
  );
}

export function AiCallsSection() {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => aiDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<AiCallsResp | null>(null);
  const [meta, setMeta] = useState<AiCallsMetaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<AiFilter>("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setD(null); setErr(null); setOpen(null);
    fetchAiCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to]);
  useEffect(() => { fetchAiCallsMeta().then(setMeta).catch(() => setMeta(null)); }, []);

  const shown = useMemo(() => (d ? d.rows.filter((r) => matchesFilter(r, filter)) : []), [d, filter]);

  const navBar = <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  if (err) return <div className="chart-card">{navBar}<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card">{navBar}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

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
            {meta.job?.lastError && <span style={{ color: "var(--danger, #b3261e)" }}> · остання помилка {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}: {meta.job.lastError}</span>}
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
                  <Fragment key={`${String(r.kommoId)}-${r.uniqueid}`}>
                    <tr onClick={() => setOpen(open === r.uniqueid ? null : r.uniqueid)} style={{ borderTop: "1px solid var(--border)", cursor: "pointer" }}>
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
                    {open === r.uniqueid && (
                      <tr><td colSpan={7} style={{ padding: "0 10px 10px", background: "var(--card-bg-alt, transparent)" }}>
                        <a href={r.dealUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>Угода {r.kommoId} в Kommo ↗</a>
                        <CallCard uniqueid={r.uniqueid} />
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}
