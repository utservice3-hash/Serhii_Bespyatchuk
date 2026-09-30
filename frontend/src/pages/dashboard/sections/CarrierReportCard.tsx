import { Fragment, useEffect, useState } from "react";
import { fetchCarrierCalls, fetchCarrierReport, type CarrierDealT, type CarrierReportLineT, type CarrierReportResp } from "../../../api";
import { InfoHint } from "../widgets";
import { CATEGORY_UI, OTHER_TYPE_UI, TONE, confLabel, deciderLabel } from "../carrierCallsView";
import { pill } from "./CarrierDealPanel";

/**
 * 📊 «ДЗВІНКИ НА МОБІЛЬНІ» У ЗВІТІ (ТЗ Романа 30.09.2026): по менеджерах — усього, клієнти, перевізники (авто / вручну),
 * інше (авто / вручну), не розібрано; тімлід бачить своїх менеджерів і суму команди. Клік по числу відкриває САМЕ
 * ці угоди — з тих самих рядків, з яких порахована клітинка (`carrierReport(carrierDealRows)`), тож число й список
 * не можуть розійтись. Ролі без вкладки «Перевізники» блок не бачать (сервер відповідає 403 — ховаємо).
 */

type Col = "total" | "clients" | "carriersAuto" | "carriersManual" | "otherAuto" | "otherManual" | "unsorted" | "overdue";
const COLS: readonly { key: Col; label: string; match: (r: CarrierDealT) => boolean }[] = [
  { key: "total", label: "Усього", match: (r) => r.category !== "no_talk" },
  { key: "clients", label: "Клієнти", match: (r) => r.category === "client" },
  { key: "carriersAuto", label: "Перевізники · AI", match: (r) => r.category === "carrier" && r.source !== "human" },
  { key: "carriersManual", label: "Перевізники · вручну", match: (r) => r.category === "carrier" && r.source === "human" },
  { key: "otherAuto", label: "Інше · AI", match: (r) => r.category === "other" && r.source !== "human" },
  { key: "otherManual", label: "Інше · вручну", match: (r) => r.category === "other" && r.source === "human" },
  { key: "unsorted", label: "Не розібрано", match: (r) => r.category === "review" || r.category === "error" || r.category === "waiting" },
  { key: "overdue", label: "з них прострочено", match: (r) => r.overdue },
];
const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const muted: React.CSSProperties = { color: "var(--text-muted)" };
const num: React.CSSProperties = { padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

type Pick = { who: "manager" | "team" | "all"; id: number | null; col: Col; title: string };

export function CarrierReportCard({ from, to, managerId, teamId }: { from: string; to: string; managerId?: number; teamId?: number }) {
  const [rep, setRep] = useState<CarrierReportResp | null>(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<CarrierDealT[] | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);

  useEffect(() => {
    let alive = true;
    setRep(null); setRows(null); setPick(null); setErr(null);
    fetchCarrierReport({ from, to, managerId, teamId })
      .then((x) => { if (alive) setRep(x); })
      .catch((e) => {
        if (!alive) return;
        if ((e as { response?: { status?: number } }).response?.status === 403) setHidden(true);
        else setErr(e instanceof Error ? e.message : "Не вдалося завантажити");
      });
    return () => { alive = false; };
  }, [from, to, managerId, teamId]);

  const open = async (p: Pick) => {
    if (pick && pick.who === p.who && pick.id === p.id && pick.col === p.col) { setPick(null); return; }
    setPick(p);
    if (!rows) {
      try { setRows((await fetchCarrierCalls({ from, to, managerId, teamId })).rows); }
      catch (e) { setErr(e instanceof Error ? e.message : "Не вдалося завантажити список"); }
    }
  };

  if (hidden) return null;
  const head = (
    <h2 className="chart-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      Дзвінки на мобільні
      <InfoHint text="Угоди етапу «Дзвінки на мобільні», що лишились після фільтра CRM, — хто це виявився: клієнт, перевізник чи інше; AI — упевнений вердикт, вручну — рішення менеджера, тімліда чи керівника. «Не розібрано» — на перевірці, помилка або AI ще слухає; «прострочено» — не розібрані до кінця робочого дня (18:00, Пн–Пт). «Без розмови» (коротше 10 с — закрито «Немає зв'язку», не аналізуємо) і «Прибрав фільтр» — окремо, у «Усього» не входять. Облік — з 30.09.2026 12:48. Клік по числу — список угод." />
    </h2>
  );
  if (err) return <div className="chart-card">{head}<p style={{ margin: 0, color: "var(--danger)" }}>{err}</p></div>;
  if (!rep) return <div className="chart-card">{head}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;
  if (rep.total.total === 0 && rep.filterRemoved === 0) return <div className="chart-card">{head}<p style={{ margin: 0, ...muted }}>За період угод на етапі не було.</p></div>;

  const teamsShown = rep.teams.length > 1;
  const cellBtn = (line: CarrierReportLineT | CarrierReportResp["total"], p: Omit<Pick, "col" | "title">, title: string) => COLS.map((c) => {
    const v = line[c.key];
    const on = pick?.who === p.who && pick.id === p.id && pick.col === c.key;
    return (
      <td key={c.key} style={{ ...num, fontWeight: c.key === "total" ? 600 : 400, color: c.key === "overdue" && v > 0 ? "var(--danger)" : undefined }}>
        {v === 0 ? <span style={muted}>0</span>
          : <button type="button" onClick={() => { void open({ ...p, col: c.key, title: `${title} · ${c.label}` }); }} aria-pressed={on}
              style={{ border: 0, background: on ? "var(--info-bg)" : "none", color: c.key === "overdue" ? "var(--danger)" : "var(--info)", cursor: "pointer", padding: "1px 4px", borderRadius: 4, fontVariantNumeric: "tabular-nums", font: "inherit" }}>{v}</button>}
      </td>
    );
  });
  const picked = pick && rows ? rows.filter((r) => (pick.who === "all" || (pick.who === "manager" ? r.managerId === pick.id : r.teamId === pick.id))
    && (COLS.find((c) => c.key === pick.col)?.match(r) ?? false)) : null;

  return (
    <div className="chart-card" style={{ overflowX: "auto" }}>
      {head}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
        <thead>
          <tr style={{ ...muted, fontSize: 12.5 }}>
            <th style={{ textAlign: "left", padding: "6px 10px" }}>Менеджер</th>
            {COLS.map((c) => <th key={c.key} style={num}>{c.label}</th>)}
            <th style={num}>Без розмови</th>
            <th style={num}>Прибрав фільтр</th>
          </tr>
        </thead>
        <tbody>
          {(teamsShown ? rep.teams : [null]).map((t) => {
            const mgrs = rep.managers.filter((m) => t == null || m.teamId === t.teamId);
            return (
              <Fragment key={t?.teamId ?? "one"}>
                {mgrs.map((m) => (
                  <tr key={m.managerId ?? "none"} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 10px" }}>{m.managerName ?? <span style={muted}>без менеджера</span>}</td>
                    {cellBtn(m, { who: "manager", id: m.managerId }, m.managerName ?? "без менеджера")}
                    <td style={{ ...num, ...muted }}>{m.noTalk}</td>
                    <td style={{ ...num, ...muted }}>{m.filterRemoved ?? 0}</td>
                  </tr>
                ))}
                {t && mgrs.length > 1 && (
                  <tr style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", fontWeight: 600 }}>
                    <td style={{ padding: "6px 10px" }}>Разом · {t.teamName ?? "поза командами"}</td>
                    {cellBtn(t, { who: "team", id: t.teamId }, t.teamName ?? "поза командами")}
                    <td style={{ ...num, ...muted }}>{t.noTalk}</td>
                    <td style={{ ...num, ...muted }}>{mgrs.reduce((s, m) => s + (m.filterRemoved ?? 0), 0)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rep.managers.length > 1 && <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
            <td style={{ padding: "6px 10px" }}>{teamsShown || rep.managers.length > 1 ? "Разом" : "Разом по команді"}</td>
            {cellBtn(rep.total, { who: "all", id: null }, "Разом")}
            <td style={{ ...num, ...muted }}>{rep.total.noTalk}</td>
            <td style={{ ...num, ...muted }}>{rep.filterRemoved}</td>
          </tr>}
        </tbody>
      </table>
      {pick && (
        <div className="cq-fade" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{pick.title}{picked ? ` — ${String(picked.length)}` : ""}</div>
          {!picked ? <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>
            : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {picked.map((r) => {
                    const cat = CATEGORY_UI[r.category];
                    return (
                      <tr key={r.kommoId} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}><a href={r.url} target="_blank" rel="noreferrer">№ {r.kommoId}</a></td>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap", ...muted }}>{fmtTime(r.createdAt)}</td>
                        <td style={{ padding: "5px 10px" }}>{r.managerName ?? <span style={muted}>без менеджера</span>}</td>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                          <span style={pill(TONE[cat.tone].bg, TONE[cat.tone].fg)}>{cat.label}{r.otherType ? ` · ${OTHER_TYPE_UI[r.otherType]}` : ""}</span>
                          <span style={{ ...muted, fontSize: 12, marginLeft: 6 }}>{r.source === "human" && r.human ? deciderLabel(r.human.role) : r.source === "ai" ? `AI ${confLabel(r.ai.confidence)}` : r.why ?? ""}</span>
                        </td>
                        <td style={{ padding: "5px 10px", ...muted }}>{r.human?.note ?? r.ai.reason ?? r.ai.quote ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
        </div>
      )}
    </div>
  );
}
