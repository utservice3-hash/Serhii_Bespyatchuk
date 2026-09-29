import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchCarrierCallCard, fetchCarrierCalls, fetchCarrierCallsMeta, revertCarrierClose,
  type CarrierCallCardResp, type CarrierCallsMetaResp, type CarrierCallsResp } from "../../../api";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { STATE_UI, TONE_COLOR, mmss, jobErrorIsCurrent } from "../aiCallsView";
import { BUCKET_UI, CARRIER_FILTERS, TONE, carrierSpeaker, closeLabel, closeModeLabel, confLabel, dealStatusLabel, dealsWord, matchesCarrierFilter,
  type CarrierFilter } from "../carrierCallsView";

/**
 * 🚚 «ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ» — лише керівництво, лише перегляд (ТЗ 29.09.2026, макет — на ньому).
 *
 * Хто подзвонив менеджеру на мобільний, коли фільтр CRM цю людину не впізнав: AI слухає першу розмову
 * номера й каже «перевізник / клієнт / інше / не розібрати» з цитатою співрозмовника. У Kommo нічого не пишемо.
 * Правила (15 хв після фільтра, розмова від 10 с, вердикт на номер 30 днів) — METRICS_GLOSSARY §17.
 * Повний текст розмови сервер віддає лише адміну й КВП; тут показуємо те, що прийшло.
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
const usd = (v: number) => `$${v.toFixed(2)}`;
const pill = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap", fontWeight: 600 });

const FLOW = ["Дзвінок на мобільний", "Угода на етапі", "Фільтр CRM · раз на 10 хв", "Не впізнав — лишилась", "AI слухає першу розмову номера", "Вердикт тут"];

function CallDetail({ uniqueid, onChanged }: { uniqueid: string; onChanged: () => void }) {
  const [c, setC] = useState<CarrierCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchCarrierCallCard(uniqueid).then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити розмову"); });
    return () => { alive = false; };
  }, [uniqueid, reload]);
  const revert = async (kommoId: number) => {
    if (!window.confirm(`Повернути угоду № ${String(kommoId)} на етап «Дзвінки на мобільні» і зняти причину «Перевізник»? Автоматика її більше не закриватиме.`)) return;
    setBusy(kommoId);
    try { await revertCarrierClose(kommoId); setReload((n) => n + 1); onChanged(); }
    catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e instanceof Error ? e.message : "не вдалося");
      window.alert(`Не повернуто: ${msg}`);
    } finally { setBusy(null); }
  };
  if (err) return <p style={{ margin: 0, color: "var(--danger)" }}>{err}</p>;
  if (!c) return <p className="loading-text" style={{ margin: 0 }}>Завантаження розмови…</p>;
  const quote = c.result?.caller_role_quote?.trim() ?? "";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12, background: "var(--card-bg)",
      border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
      <div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, marginBottom: 4 }}>РЕЗЮМЕ</div>
        <p style={{ margin: 0, fontSize: 13 }}>{c.result?.summary || <span style={{ color: "var(--text-muted)" }}>{c.failure ?? "вердикту ще немає"}</span>}</p>
        {c.firstTry && (
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>
            Це друга розмова номера: першу не вдалось розібрати{c.firstTry.role ? ` (${c.firstTry.role === "unclear" ? "не розібрати" : c.firstTry.role})` : " (без запису)"}.
          </p>
        )}
        {c.deals.length > 0 && (
          <div style={{ margin: "6px 0 0", fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
            {c.deals.map((d) => (
              <div key={d.kommoId} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <a href={d.url} target="_blank" rel="noreferrer" style={{ whiteSpace: "nowrap" }}>№ {d.kommoId}</a>
                {d.reused && <span style={{ color: "var(--text-muted)" }}>(вердикт номера)</span>}
                {closeLabel(d.close, fmtTime) && <span style={{ color: "var(--text-muted)" }}>· {closeLabel(d.close, fmtTime)}</span>}
                {d.close?.state === "closed" && (
                  <button type="button" disabled={busy === d.kommoId} onClick={() => { void revert(d.kommoId); }}
                    style={{ border: "1px solid var(--border-strong, #d1d5db)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>
                    {busy === d.kommoId ? "Повертаю…" : "Повернути на етап"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, marginBottom: 4 }}>РОЗМОВА</div>
        {c.textPurged
          ? <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Текст видалено за строком зберігання (12 місяців). Вердикт і цитата лишились.</p>
          : c.transcriptHidden
            ? <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Повний текст бачать адмін і КВП. Цитата співрозмовника — у рядку.</p>
            : !c.turns?.length
              ? <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Розшифровки ще немає.</p>
              : <div style={{ maxHeight: 220, overflowY: "auto" }}>
                  {c.turns.map((t, i) => {
                    const who = carrierSpeaker(t.channel, c.managerChannel);
                    const hit = quote && t.channel !== c.managerChannel && t.text.includes(quote);
                    return (
                      <p key={i} style={{ margin: "2px 0", fontSize: 13 }}>
                        <span style={{ fontWeight: 600, marginRight: 6, color: who === "Співрозмовник" ? "var(--warn)" : "var(--text-muted)" }}>{who}</span>
                        {hit ? <mark style={{ background: "var(--warn-bg)", color: "inherit", borderRadius: 3 }}>{t.text}</mark> : t.text}
                      </p>
                    );
                  })}
                </div>}
      </div>
    </div>
  );
}

export function CarrierCallsSection() {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => ({ mode: "week", anchor: today, focusDay: today, rangeFrom: today, rangeTo: today }));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<CarrierCallsResp | null>(null);
  const [meta, setMeta] = useState<CarrierCallsMetaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<CarrierFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setD(null); setErr(null);
    fetchCarrierCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to, refresh]);
  useEffect(() => { fetchCarrierCallsMeta().then(setMeta).catch(() => setMeta(null)); }, [refresh]);

  const rows = d?.rows ?? [];
  const shown = useMemo(() => rows.filter((r) => matchesCarrierFilter(r, filter)), [rows, filter]);

  const navBar = <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  const header = (
    <>
      {navBar}
      <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Перевізники за розмовою
        <span style={pill("var(--danger-bg)", "var(--danger)")}>лише керівництво</span>
        <InfoHint text="Етап «Дзвінки на мобільні» (Кваліфікація). Фільтр CRM прибирає тих, кого знає за списками; AI слухає решту — першу розмову кожного номера від 10 с — і каже, хто дзвонив. Угоди без розмови не показуються, їх число — нижче. У Kommo нічого не змінюється. Період — за датою створення угоди." />
      </h3>
      <ol aria-label="Як угода доходить до AI" style={{ listStyle: "none", margin: "0 0 10px", padding: 0, display: "flex", flexWrap: "wrap", gap: 6, fontSize: 12.5 }}>
        {FLOW.map((x, i) => (
          <li key={x} style={{ border: `1px solid ${i === 3 || i === 4 ? "var(--warn)" : "var(--border)"}`, borderRadius: 999, padding: "2px 10px",
            color: i === 3 || i === 4 ? "var(--text)" : "var(--text-muted)" }}>{i > 0 && "→ "}{x}</li>
        ))}
      </ol>
    </>
  );
  if (err) return <div className="chart-card">{header}<p style={{ margin: 0, color: "var(--danger)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card">{header}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const k = d.kpis;
  const count = (b: string) => rows.filter((r) => r.bucket === b).length;
  const tile = (label: string, value: number, sub: string, hint: string, tone?: string) => (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: tone }}>{value.toLocaleString("uk-UA")}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", gap: 4, alignItems: "center" }}>{label}<InfoHint text={hint} /></div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{sub}</div>
    </div>
  );
  const since = k.recordingSince ? k.recordingSince.slice(0, 10) : null;
  const cell: React.CSSProperties = { padding: "7px 10px", verticalAlign: "top" };

  return (
    <>
      <div className="chart-card">
        {header}
        {meta && (
          <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-muted)" }}>
            Конвеєр: {meta.job?.lastSuccessAt ? `останній успішний запуск ${fmtTime(meta.job.lastSuccessAt)}` : "успішних запусків ще не було"}
            {meta.job?.lastError && jobErrorIsCurrent(meta.job)
              && <span style={{ color: "var(--danger)" }}> · остання помилка {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}: {meta.job.lastError}</span>}
            {" · "}у черзі {(meta.transcripts.queued ?? 0) + (meta.analyses.queued ?? 0)}
            {" · "}витрати мобільних за місяць {usd(meta.spend.carrier)} з {usd(meta.caps.carrier)}
            {" · "}усього AI: розпізнавання {usd(meta.spend.stt)}{meta.caps.stt != null ? ` з ${usd(meta.caps.stt)}` : ""},
            {" "}аналіз {usd(meta.spend.analysis)}{meta.caps.analysis != null ? ` з ${usd(meta.caps.analysis)}` : ""}
            <br />{closeModeLabel(meta.close.mode)}: {meta.close.mode === "live"
              ? `закрито ${String(meta.close.closed)}, повернуто людьми ${String(meta.close.reverted)}${meta.close.failed ? `, не вдалось ${String(meta.close.failed)}` : ""}`
              : `закрили б ${String(meta.close.wouldClose)}`}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          {tile("Прибрав фільтр CRM", k.removedByFilter, "AI їх не слухає",
            "Угоди етапу, які фільтр CRM закрив як «Перевізник». За даними CRM — оновлюються раз на 30 хв.")}
          {tile("Лишилось після фільтра", k.leftAfterFilter, `прослухано номерів: ${String(k.listenedPhones)}`,
            "Угоди, які стояли на етапі після фільтра (ми фіксуємо це в момент, коли бачимо). З розмовою й без.")}
          {tile("Перевізник за розмовою", count("carrier"), "фільтр їх не знав", BUCKET_UI.carrier.hint, "var(--warn)")}
          {tile("Клієнт за розмовою", count("client"), "", BUCKET_UI.client.hint, "var(--ok)")}
          {tile("Інше · не розібрати · нижче порогу", count("other") + count("unclear") + count("low"), "",
            "Розмова не про перевезення, розібрати не вдалось, або модель не впевнена.")}
        </div>
        <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-muted)" }}>
          Без розмови не показуємо: чекають розмови — {k.waitingTalk}, пропущено (розмова коротша 10 с або її не було за добу) — {k.noTalk}.
          {since && since > from && <> Облік «після фільтра» ведеться з {fmtDate(k.recordingSince!)} — за раніші дні чисел немає.</>}
          {!since && <> Облік «після фільтра» ще не почався.</>}
        </p>
        {d.truncated && <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--warn)" }}>Показано перші 5 000 — звузьте період.</p>}
        <div role="group" aria-label="Фільтр за вердиктом" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {CARRIER_FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
              style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "3px 12px", fontSize: 13, cursor: "pointer",
                background: filter === f.key ? "var(--accent-bg, #e8f0fb)" : "transparent", fontWeight: filter === f.key ? 600 : 400 }}>
              {f.label} · {rows.filter((r) => matchesCarrierFilter(r, f.key)).length}
            </button>
          ))}
        </div>
      </div>

      <div className="chart-card" style={{ overflowX: "auto" }}>
        {shown.length === 0
          ? <p style={{ margin: 0, color: "var(--text-muted)" }}>{rows.length === 0 ? "У періоді немає прослуханих розмов після фільтра." : "Під цей фільтр розмов немає."}</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12.5 }}>
                  <th style={cell}>Розмова</th><th style={cell}>Угода</th><th style={cell}>Менеджер</th><th style={cell}>Хто дзвонив</th>
                  <th style={cell}>Що сказав співрозмовник</th><th style={cell}>Що зроблено</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const main = r.deals[0];
                  const isOpen = open === r.uniqueid;
                  const toggle = () => setOpen(isOpen ? null : r.uniqueid);
                  return (
                    <Fragment key={r.uniqueid}>
                      <tr tabIndex={0} aria-expanded={isOpen} aria-label={`Розгорнути розмову ${fmtTime(r.calledAt)}`}
                        onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                        style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: isOpen ? "var(--surface-2)" : undefined }}>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          {fmtTime(r.calledAt)}
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec)}{r.talkNo === 2 ? " · друга розмова" : ""}</div>
                        </td>
                        <td style={cell}>
                          {main ? <a href={main.url} target="_blank" rel="noreferrer" style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>№ {main.kommoId}</a> : "—"}
                          {r.deals.length > 1 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>+ ще {r.deals.length - 1} {dealsWord(r.deals.length - 1)} цього номера</div>}
                        </td>
                        <td style={cell}>{r.managerName ?? <span style={{ color: "var(--text-muted)" }}>невідомий</span>}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          {r.bucket
                            ? <><span title={BUCKET_UI[r.bucket].hint} style={pill(TONE[BUCKET_UI[r.bucket].tone].bg, TONE[BUCKET_UI[r.bucket].tone].fg)}>{BUCKET_UI[r.bucket].label}</span>
                                <span style={{ fontSize: 12, marginLeft: 4, color: r.bucket === "low" ? "var(--danger)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{confLabel(r.confidence)}</span></>
                            : <span title={STATE_UI[r.state].hint} style={pill(TONE_COLOR[STATE_UI[r.state].tone].bg, TONE_COLOR[STATE_UI[r.state].tone].fg)}>{STATE_UI[r.state].label}</span>}
                        </td>
                        <td style={{ ...cell, maxWidth: 420 }}>
                          {r.quote ? <i>«{r.quote}»</i> : r.summary ? <span style={{ color: "var(--text-muted)" }}>{r.summary}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}
                        </td>
                        <td style={{ ...cell, fontSize: 12.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {closeLabel(main?.close ?? null, fmtTime) ?? (r.bucket ? "вердикт записано" : "ще слухаємо")}
                          <div>{main ? dealStatusLabel(main.statusId, main.rejectReason) : ""}</div>
                        </td>
                      </tr>
                      {isOpen && <tr><td colSpan={6} style={{ padding: "0 10px 12px", background: "var(--surface-2)" }}><CallDetail uniqueid={r.uniqueid} onChanged={() => setRefresh((n) => n + 1)} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}
