import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchCarrierCalls, fetchCarrierCallsMeta, fetchCarrierPending,
  type CarrierCallsMetaResp, type CarrierCallsResp, type CarrierDealT, type CarrierOtherTypeT } from "../../../api";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { jobErrorIsCurrent, mmss } from "../aiCallsView";
import { CARRIER_STAGE_STATUS, CARRIER_TABS, CATEGORY_UI, OTHER_TYPE_UI, OTHER_TYPES_HINT, ROLE_UI, TONE, closeLabel, closeModeLabel, dealStatusLabel, deciderLabel, pctLabel,
  otherModeLabel, tabOf, type CarrierTab } from "../carrierCallsView";
import { CarrierDealPanel, pill } from "./CarrierDealPanel";

/**
 * 🚚 «ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ» — відсів дзвінків на мобільні (29.09.2026; ТЗ Романа 30.09.2026).
 *
 * Дзвінок на мобільний → угода на етапі «Дзвінки на мобільні» → фільтр CRM прибирає знайомих → AI слухає першу
 * розмову решти (від 10 с) і каже: клієнт, перевізник чи інше (з підтипом). Упевнених перевізників і «Інше»
 * дашборд закриває в CRM, клієнт лишається; решту — «На перевірці» — вирішує людина. Сервер сам звужує список:
 * менеджер бачить свої угоди, тімлід — команду, керівництво — усі. Правила — METRICS_GLOSSARY §17.
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
const usd = (v: number) => `$${v.toFixed(2)}`;
const muted: React.CSSProperties = { color: "var(--text-muted)" };

/** Заголовок колонки з поясненням під ⓘ (прохання Романа 30.09.2026: «знаки питання над незрозумілими значеннями»). */
function Hd({ t, h }: { t: string; h: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{t}<InfoHint text={h} /></span>;
}

function Verdict({ r }: { r: CarrierDealT }) {
  const cat = CATEGORY_UI[r.category];
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span title={cat.hint} style={pill(TONE[cat.tone].bg, TONE[cat.tone].fg)}>{cat.label}{r.otherType ? ` · ${OTHER_TYPE_UI[r.otherType]}` : ""}</span>
      {r.overdue && <span title={`Не розібрано до кінця робочого дня: треба було до ${fmtTime(r.reviewDeadline!)}`} style={pill(TONE.bad.bg, TONE.bad.fg)}>прострочено</span>}
      <span style={{ fontSize: 12, ...muted, fontVariantNumeric: "tabular-nums" }}
        title={r.source === "human" ? "Так вирішила людина — це сильніше за AI" : "Впевненість AI: наскільки він певен у вердикті. Від 85% — рішення приймає сам, нижче — вирішуєте ви"}>
        {r.source === "human" && r.human ? `вирішив ${deciderLabel(r.human.role)}`
          : r.source === "ai" ? `AI, впевненість ${pctLabel(r.ai.confidence)}`
          : r.ai.verdict ? `AI думає: ${ROLE_UI[r.ai.verdict]?.label ?? r.ai.verdict}, ${pctLabel(r.ai.confidence)}` : ""}
      </span>
    </span>
  );
}

/**
 * `roleKey` — лише для ВИГЛЯДУ (межу тримає сервер): менеджер не бачить службового рядка (витрати, режими), колонки
 * «Менеджер» (там завжди він) і точності AI; тімлід — службового рядка й точності. Рішення Романа 30.09.2026.
 */
export function CarrierCallsSection({ roleKey = null }: { roleKey?: string | null }) {
  const isManager = roleKey === "manager";
  const isLead = roleKey !== "manager" && roleKey !== "team_lead";
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => ({ mode: "week", anchor: today, focusDay: today, rangeFrom: today, rangeTo: today }));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<CarrierCallsResp | null>(null);
  const [meta, setMeta] = useState<CarrierCallsMetaResp | null>(null);
  const [pendingAll, setPendingAll] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<CarrierTab>("review");
  const [sub, setSub] = useState<CarrierOtherTypeT | "all">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setErr(null);
    fetchCarrierCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to, refresh]);
  useEffect(() => { fetchCarrierCallsMeta().then(setMeta).catch(() => setMeta(null)); }, [refresh]);
  useEffect(() => { fetchCarrierPending().then((p) => setPendingAll(p.pending.length)).catch(() => setPendingAll(null)); }, [refresh]);

  const rows = useMemo(() => d?.rows ?? [], [d]);
  const inTab = useMemo(() => rows.filter((r) => tabOf(r.category) === tab), [rows, tab]);
  const shown = useMemo(() => (tab === "other" && sub !== "all" ? inTab.filter((r) => r.otherType === sub) : inTab), [inTab, tab, sub]);
  const count = (t: CarrierTab) => rows.filter((r) => tabOf(r.category) === t).length;
  const overdueN = rows.filter((r) => r.overdue).length;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Рішення записано: у «На перевірці» рядок плавно відходить і відкривається наступний — черга розбирається підряд. */
  const onDecided = (kommoId: number) => {
    const idx = shown.findIndex((r) => r.kommoId === kommoId);
    const next = tab === "review" ? (shown[idx + 1] ?? shown[idx - 1])?.kommoId ?? null : kommoId;
    const finish = () => { setLeaving(null); setOpen(next); setRefresh((n) => n + 1); };
    if (tab !== "review" || reduce) { finish(); return; }
    setLeaving(kommoId); setOpen(null);
    setTimeout(finish, 300);
  };

  const header = (
    <>
      <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />
      <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Перевізники за розмовою
        <InfoHint text="Дзвінок на мобільний → угода на етапі «Дзвінки на мобільні» → фільтр CRM прибирає знайомих → AI слухає першу розмову решти (від 10 с): клієнт, перевізник чи інше. Упевнених перевізників і «Інше» дашборд закриває в CRM, клієнт лишається. Невпевнених і без розмови вирішує людина: менеджер — свої, тімлід — команди, керівництво — усі. Період — за датою створення угоди." />
      </h3>
    </>
  );
  if (err) return <div className="chart-card">{header}<p style={{ margin: 0, color: "var(--danger)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card">{header}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const k = d.kpis;
  const since = k.recordingSince ? k.recordingSince.slice(0, 10) : null;
  const cell: React.CSSProperties = { padding: "7px 10px", verticalAlign: "top" };
  const reviewOutside = pendingAll != null ? pendingAll - rows.filter((r) => (r.category === "review" || r.category === "error") && !r.human
    && r.close?.state !== "closed" && (r.crm.statusId == null || r.crm.statusId === CARRIER_STAGE_STATUS)).length : 0;
  const subCount = (t: CarrierOtherTypeT) => inTab.filter((r) => r.otherType === t).length;
  const unknownSub = tab === "other" ? inTab.filter((r) => r.otherType == null).length : 0;

  return (
    <>
      <div className="chart-card">
        {header}
        {meta && isLead && (
          <p style={{ margin: "0 0 10px", fontSize: 12.5, ...muted }}
            title={`Усього AI за місяць: розпізнавання ${usd(meta.spend.stt)}, аналіз ${usd(meta.spend.analysis)}. У черзі: ${String((meta.transcripts.queued ?? 0) + (meta.analyses.queued ?? 0))}.`}>
            Оновлено {meta.job?.lastSuccessAt ? fmtTime(meta.job.lastSuccessAt) : "—"}
            {meta.job?.lastError && jobErrorIsCurrent(meta.job) && <span style={{ color: "var(--danger)" }}> · помилка: {meta.job.lastError}</span>}
            {" · "}витрати {usd(meta.spend.carrier)} / {usd(meta.caps.carrier)}
            {" · "}перевізники: {closeModeLabel(meta.close.mode)}{meta.close.mode === "live" ? ` (${String(meta.close.closed)})` : ""}
            {" · "}«Інше» від AI: {otherModeLabel(meta.close.mode, meta.close.otherMode)}
            {meta.close.otherMode !== "live" && meta.close.otherWouldClose > 0 ? ` (у журналі ${String(meta.close.otherWouldClose)})` : ""}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          {[
            ["Відсіяв фільтр CRM", k.removedByFilter, "Угоди, які фільтр CRM закрив сам як «Перевізник» ще до AI: номер із Lardi чи зі списку відомих перевізників. AI їх не слухає."],
            ["Слухав AI", k.leftAfterFilter - k.noTalk, `Угоди, що пройшли фільтр CRM і мали розмову від 10 с, — усі чотири вкладки нижче разом. Ще чекають розмову: ${String(k.waitingTalk)}.`],
            ["Без розмови", k.noTalk, "Розмови від 10 с не було (пропущений або короткий дзвінок): AI не слухає, через 4 год дашборд закриває угоду в CRM як «Немає зв'язку»."],
          ].map(([l, v, h]) => (
            <div key={String(l)} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", minWidth: 130, flex: "1 1 130px" }}>
              <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{Number(v).toLocaleString("uk-UA")}</div>
              <div style={{ fontSize: 12.5, ...muted, display: "flex", gap: 4, alignItems: "center" }}>{l}<InfoHint text={String(h)} /></div>
            </div>
          ))}
        </div>
        {since && since > from && <p style={{ margin: "0 0 8px", fontSize: 12.5, ...muted }}>Облік ведеться з {fmtDate(k.recordingSince!)}.</p>}
        {!since && <p style={{ margin: "0 0 8px", fontSize: 12.5, ...muted }}>Облік ще не почався.</p>}
        {d.truncated && <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--warn)" }}>Показано перші 5 000 — звузьте період.</p>}
        <div role="tablist" aria-label="Категорії" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {CARRIER_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" onClick={() => { setTab(t.key); setOpen(null); setSub("all"); }} aria-selected={tab === t.key}
              style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "4px 14px", fontSize: 13.5, cursor: "pointer",
                background: tab === t.key ? "var(--accent-bg, #e8f0fb)" : "transparent", fontWeight: tab === t.key ? 600 : 400, color: "var(--text)" }}>
              {t.label} <span key={count(t.key)} className="cq-pop" style={{ fontVariantNumeric: "tabular-nums" }}>{count(t.key)}</span>
              {t.key === "review" && overdueN > 0 && <span style={{ ...pill(TONE.bad.bg, TONE.bad.fg), marginLeft: 6 }}>{overdueN} прострочено</span>}
              <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 4 }}><InfoHint text={t.hint} /></span>
            </button>
          ))}
        </div>
        {tab === "other" && inTab.length > 0 && (
          <div role="group" aria-label="Підтип «Інше»" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {(["all", ...Object.keys(OTHER_TYPE_UI)] as (CarrierOtherTypeT | "all")[]).map((t) => {
              const n = t === "all" ? inTab.length : subCount(t);
              if (t !== "all" && n === 0) return null;
              return (
                <button key={t} type="button" onClick={() => setSub(t)} aria-pressed={sub === t}
                  style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "2px 10px", fontSize: 12.5, cursor: "pointer", color: "var(--text)",
                    background: sub === t ? "var(--info-bg)" : "transparent" }}>
                  {t === "all" ? "Усі" : OTHER_TYPE_UI[t]} · {n}
                </button>
              );
            })}
            {unknownSub > 0 && <span style={{ fontSize: 12.5, ...muted, alignSelf: "center" }}>без підтипу (до 30.09): {unknownSub}</span>}
            <span style={{ alignSelf: "center" }}><InfoHint text={OTHER_TYPES_HINT} /></span>
          </div>
        )}
        {tab === "review" && reviewOutside > 0 && (
          <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--warn)" }}>Ще {reviewOutside} угод, де AI не впевнений, — поза цим періодом. Розширте період.</p>
        )}
      </div>

      <div className="chart-card" style={{ overflowX: "auto" }}>
        {shown.length === 0
          ? <p className="cq-fade" style={{ margin: 0, ...muted }}>{tab === "review" ? (rows.length ? "Усе розсортовано 👌" : "У періоді угод немає.") : "У цій вкладці за період угод немає."}</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", ...muted, fontSize: 12.5 }}>
                  <th style={cell}><Hd t="Угода" h="Номер угоди в Kommo (клік — відкрити в CRM) і коли її створено." /></th>
                  <th style={cell}><Hd t="Розмова" h="Перша розмова від 10 с з цим номером: коли, вхідна чи вихідна, тривалість." /></th>
                  {!isManager && <th style={cell}><Hd t="Менеджер" h="Відповідальний за угоду в Kommo." /></th>}
                  <th style={cell}><Hd t="Хто дзвонив" h="Вердикт: клієнт, перевізник чи інше. Поруч — хто вирішив (AI з відсотком впевненості чи людина). Від 85% AI вирішує сам." /></th>
                  <th style={cell}><Hd t="Пояснення" h="Чому саме такий вердикт: пояснення AI, коментар людини або чому AI не впевнений." /></th>
                  <th style={cell}><Hd t="У CRM" h="Що дашборд зробив з угодою в Kommo і в якому вона стані зараз (оновлюється раз на 30 хв)." /></th>
                </tr>
              </thead>
              <tbody key={tab} className="cq-fade">
                {shown.map((r) => {
                  const isOpen = open === r.kommoId;
                  const toggle = () => setOpen(isOpen ? null : r.kommoId);
                  return (
                    <Fragment key={r.kommoId}>
                      <tr className={`cq-row${leaving === r.kommoId ? " leave" : ""}`} tabIndex={0} aria-expanded={isOpen} aria-label={`Розгорнути угоду ${String(r.kommoId)}`}
                        onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                        style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: isOpen ? "var(--surface-2)" : undefined }}>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>№ {r.kommoId}</a>
                          <div style={{ fontSize: 12, ...muted }}>{fmtTime(r.createdAt)}{r.reused && <span title="Цей номер уже дзвонив за останні 30 днів — вердикт узято з тієї розмови, вдруге не слухаємо"> · вердикт з попереднього дзвінка</span>}</div>
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          {r.calledAt
                            ? <>{fmtTime(r.calledAt)}<div style={{ fontSize: 12, ...muted }}>{r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec ?? 0)}{r.talkNo === 2 && <span title="Першу розмову не вдалось розібрати — AI послухав наступну розмову з цим номером"> · друга розмова</span>}</div></>
                            : <span style={muted} title={r.dealState === "no_talk" ? CATEGORY_UI.no_talk.hint : "Розмови від 10 с ще не було — чекаємо дзвінок"}>{r.dealState === "no_talk" ? "без розмови від 10 с" : "розмови ще не було"}</span>}
                        </td>
                        {!isManager && <td style={cell}>{r.managerName ?? <span style={muted}>невідомий</span>}{r.teamName && <div style={{ fontSize: 12, ...muted }}>{r.teamName}</div>}</td>}
                        <td style={cell}><Verdict r={r} /></td>
                        <td style={{ ...cell, maxWidth: 380 }}>
                          {r.human?.note ? <span>«{r.human.note}»</span>
                            : r.ai.reason ? <span>{r.ai.reason}</span>
                            : r.ai.quote ? <i>«{r.ai.quote}»</i>
                            : <span style={muted}>{r.why ?? "—"}</span>}
                        </td>
                        <td style={{ ...cell, fontSize: 12.5, ...muted, whiteSpace: "nowrap" }}>
                          {closeLabel(r.close, fmtTime) ?? (r.category === "client" ? "лишається на етапі" : "—")}
                          <div>{dealStatusLabel(r.crm.statusId, r.crm.rejectReason)}</div>
                        </td>
                      </tr>
                      {isOpen && <tr><td colSpan={isManager ? 5 : 6} style={{ padding: "0 10px 12px", background: "var(--surface-2)" }}>
                        <div className="cq-panel"><CarrierDealPanel deal={r} onDecided={() => onDecided(r.kommoId)} onChanged={() => setRefresh((n) => n + 1)} /></div>
                      </td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>

      {meta && isLead && meta.agreement.length > 0 && (
        <details className="chart-card" style={{ fontSize: 13 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>AI проти людини — точність за рішеннями після прослуховування</summary>
          <table style={{ marginTop: 8, borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", ...muted, fontSize: 12.5 }}><th style={cell}>AI казав</th><th style={cell}>Рішень</th><th style={cell}>Людина погодилась</th><th style={cell}>Що вирішила людина</th></tr></thead>
            <tbody>
              {meta.agreement.map((a) => (
                <tr key={a.aiRole} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={cell}>{a.aiRole}</td>
                  <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{a.decisions}</td>
                  <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{a.agreed} ({a.decisions ? Math.round(a.agreed / a.decisions * 100) : 0}%)</td>
                  <td style={cell}>{Object.entries(a.byDecision).map(([k2, v]) => `${k2}: ${String(v)}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: "6px 0 0", fontSize: 12, ...muted }}>Людина вирішує, послухавши запис. Здебільшого вирішують невпевнені вердикти, тож число — нижня межа точності.</p>
        </details>
      )}
    </>
  );
}
