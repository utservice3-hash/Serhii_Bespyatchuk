import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchManagerWeeks, type ManagerWeeks, type ReportPlan, type ReportPlanManager, type Team } from "../../../api";
import { InfoHint } from "../widgets";
import {
  REPORT_COLS, OPTIONAL_COLS, DEFAULT_OPT_ON, sortRows, footValue,
  type ColDef, type ColKey,
} from "../reportTableCols";

/**
 * 📊 ТАБЛИЧНИЙ ВИГЛЯД ЗВІТУ — рядок на менеджера за обраний період.
 *
 * 🔴 ДАНІ — ТОЙ САМИЙ ОБ'ЄКТ, ЩО В КАРТКАХ. Компонент не робить ЖОДНОГО запиту
 * за рядками: він отримує вже завантажений `ReportPlan` пропсом. Це не економія
 * запитів, а гарантія: дві подачі одних даних, кожна зі своїм фетчем, розходяться
 * мовчки — і саме так ми вже отримали «місяць 0 ₴ при тижні 23 632 ₴».
 *
 * 🔴 СВІТЛОФОР — НА ТОКЕНАХ (`--ok/--warn/--danger`), а не на локальних
 * константах, як у картках. Це СВІДОМА розбіжність із `MgrStrip`: там кольори
 * захардкоджені й у темній темі не міняються. Картки не чіпаємо цим проходом,
 * але нову поверхню на хардкод не саджаємо.
 */

const nf = new Intl.NumberFormat("uk-UA");
const money = (v: number) => nf.format(Math.round(v));
const K = (v: number) => Math.round(v / 1000) + "к";
const COLS_LS = "rptTableCols";

/** Клас статусу → токен. Один вираз на весь файл. */
const TOKEN: Record<string, string> = { g: "--ok", a: "--warn", r: "--danger" };
const STATUS_LBL: Record<string, string> = { g: "В нормі", a: "Відстає", r: "Зрив" };

export function ReportTableSection({
  data, teams, auth, teamId, onTeamId, periodLabel, hideTeams,
  responseByMgr, month,
}: {
  data: ReportPlan;
  teams: Team[];
  auth: { role: string; managerId: number | null; teamId: number | null };
  teamId: number | "";
  onTeamId: (v: number | "") => void;
  periodLabel: string;
  hideTeams: Set<number>;
  /** Частка лідів >1 год по менеджеру (%). `undefined` — ще вантажиться, `null` — лідів не було. */
  responseByMgr?: Map<number, number | null>;
  /** Місяць для розкриття тижнів (YYYY-MM) — береться від початку обраного періоду. */
  month: string;
}) {
  const [sortKey, setSortKey] = useState<ColKey>("fact");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [mgrFilter, setMgrFilter] = useState<number | "">("");
  const [open, setOpen] = useState<number | null>(null);
  // Видимість колонок переживає перезавантаження — як пресети періоду в КВП.
  const [optOn, setOptOn] = useState<Record<string, boolean>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLS_LS) || "null");
      return raw && typeof raw === "object" ? { ...DEFAULT_OPT_ON, ...raw } : { ...DEFAULT_OPT_ON };
    } catch { return { ...DEFAULT_OPT_ON }; }
  });
  const toggleCol = (k: string) => setOptOn((p) => {
    const next = { ...p, [k]: !p[k] };
    localStorage.setItem(COLS_LS, JSON.stringify(next));
    return next;
  });

  // Обраний менеджер зник із набору (змінили період/команду) — фільтр знімаємо,
  // інакше екран лишився б порожнім без пояснення.
  useEffect(() => {
    if (mgrFilter !== "" && !data.managers.some((m) => m.managerId === mgrFilter)) setMgrFilter("");
  }, [data, mgrFilter]);

  const cols = useMemo(() => REPORT_COLS.filter((c) => c.core || optOn[c.key]), [optOn]);
  const rows = useMemo(() => {
    const base = mgrFilter === "" ? data.managers : data.managers.filter((m) => m.managerId === mgrFilter);
    // Контекст потрібен, бо частка повільних лідів приходить окремим запитом і не
    // лежить у рядку менеджера. Без нього клік по цій колонці нічого не робив би —
    // чип є, сортування мертве.
    return sortRows(base, sortKey, sortDir, { slowByMgr: responseByMgr });
  }, [data.managers, mgrFilter, sortKey, sortDir, responseByMgr]);

  const onSort = (k: ColKey) => {
    if (k === "rank") return;
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === "name" ? 1 : -1); }
  };

  const scopeLabel = mgrFilter !== "" ? "Менеджер"
    : teamId !== "" ? "Команда" : "Весь відділ";

  return (
    <div>
      {/* ── Обсяг: перевикористовує teamId-механізм Звіту (серверний зріз),
             менеджер фільтрує вже завантажений набір локально. */}
      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Обсяг:</span>
        <select
          value={mgrFilter !== "" ? `mgr:${mgrFilter}` : teamId !== "" ? `team:${teamId}` : "all"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "all") { setMgrFilter(""); if (auth.role === "admin") onTeamId(""); }
            else if (v.startsWith("team:")) { setMgrFilter(""); onTeamId(Number(v.slice(5))); }
            else setMgrFilter(Number(v.slice(4)));
          }}
          style={selStyle}
        >
          <option value="all">Весь відділ</option>
          {auth.role === "admin" && teams.filter((t) => !hideTeams.has(t.id)).map((t) => (
            <option key={`team:${t.id}`} value={`team:${t.id}`}>Команда · {t.name}</option>
          ))}
          {data.managers.map((m) => (
            <option key={`mgr:${m.managerId}`} value={`mgr:${m.managerId}`}>Менеджер · {m.name}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {rows.length} {rows.length === 1 ? "рядок" : rows.length < 5 ? "рядки" : "рядків"} · {periodLabel}
        </span>
      </div>

      {/* ── Чипи колонок */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Колонки:</span>
        {OPTIONAL_COLS.map((c) => (
          <button key={c.key} onClick={() => toggleCol(c.key)} aria-pressed={!!optOn[c.key]}
            style={{
              border: `1px solid ${optOn[c.key] ? "var(--brand)" : "var(--border)"}`,
              background: optOn[c.key] ? "var(--brand)" : "var(--card-bg)",
              color: optOn[c.key] ? "#fff" : "var(--text-muted)",
              borderRadius: "var(--r-pill)", padding: "4px 12px", fontSize: 12, cursor: "pointer",
            }}>{c.title}</button>
        ))}
      </div>

      <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table rpt-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} onClick={() => onSort(c.key)}
                    className={c.key === "name" ? "sticky-mgr" : undefined}
                    style={{
                      position: "sticky", top: 0, zIndex: c.key === "name" ? 4 : 2,
                      background: "var(--surface-2)", cursor: c.key === "rank" ? "default" : "pointer",
                      textAlign: c.left ? "left" : "right", whiteSpace: "nowrap",
                      fontSize: 11, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase",
                      color: c.key === sortKey ? "var(--brand)" : "var(--text-muted)",
                      padding: "10px 12px", borderBottom: "1px solid var(--border-strong)",
                      ...(c.key === "name" ? { left: 0, boxShadow: "6px 0 8px -6px rgba(0,0,0,.18)" } : null),
                    }}>
                    {c.title}
                    {c.hint && <> <InfoHint text={c.hint} /></>}
                    {c.key !== "rank" && (
                      <span style={{ marginLeft: 3, fontSize: 9, opacity: c.key === sortKey ? 1 : 0.35 }}>
                        {c.key === sortKey ? (sortDir === -1 ? "▼" : "▲") : "↕"}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <Fragment key={m.managerId}>
                  <tr onClick={() => setOpen(open === m.managerId ? null : m.managerId)}
                      style={{ cursor: "pointer" }}>
                    {cols.map((c) => (
                      <Cell key={c.key} col={c} m={m} idx={i} isOpen={open === m.managerId}
                            responseByMgr={responseByMgr} />
                    ))}
                  </tr>
                  {open === m.managerId && (
                    <tr>
                      <td colSpan={cols.length} style={{ padding: 0, background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                        <WeeksDrill managerId={m.managerId} month={month} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={cols.length} style={{ padding: 20, color: "var(--text-muted)" }}>
                  Немає менеджерів у цьому розрізі.
                </td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                {cols.map((c) => (
                  <FootCell key={c.key} col={c} rows={rows} scopeLabel={scopeLabel} count={rows.length} />
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 11, lineHeight: 1.55 }}>
        <b style={{ color: "var(--text)" }}>Клік по менеджеру</b> розкриває його тижні: план кожного
        тижня — той, що був <b style={{ color: "var(--text)" }}>зафіксований у понеділок</b>, а не
        перерахований зараз. Клік на заголовок — сортування; рядки без даних завжди внизу. Перша колонка залипає при
        горизонтальному скролі. <b style={{ color: "var(--text)" }}>Сер. чек, Викон. % і Конв.</b> у
        підсумку рахуються від сум чисельника й знаменника, а не складанням стовпчика — це частки,
        і додавати їх не можна.
      </div>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
  borderRadius: "var(--r-md)", padding: "7px 11px", fontSize: 12, cursor: "pointer", minWidth: 230,
};
const tdBase: React.CSSProperties = {
  padding: "9px 12px", textAlign: "right", whiteSpace: "nowrap",
  borderBottom: "1px solid var(--border)", fontSize: 13,
};
const none = <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>—</span>;

/** Бейдж «Викон. %» — НЕЙТРАЛЬНИЙ. Колір стану вже несе крапка статусу, і вона
 *  рахується від темпу; фарбувати бейдж за відсотком означало б показати два різні
 *  вердикти про одну людину в одному рядку. */
function pctBadge(pct: number | null) {
  if (pct == null) return <span style={{ ...badge, background: "var(--surface-2)", color: "var(--text-muted)" }}>—</span>;
  return <span style={{ ...badge, background: "var(--surface-2)", color: "var(--text)" }}>{pct}%</span>;
}
const badge: React.CSSProperties = {
  display: "inline-block", padding: "2px 8px", borderRadius: "var(--r-pill)", fontSize: 12, fontWeight: 600,
};

function Cell({ col, m, idx, isOpen, responseByMgr }: {
  col: ColDef; m: ReportPlanManager; idx: number; isOpen: boolean;
  responseByMgr?: Map<number, number | null>;
}) {
  const st: React.CSSProperties = { ...tdBase, textAlign: col.left ? "left" : "right" };
  switch (col.key) {
    case "rank":
      return <td style={{ ...st, color: "var(--text-muted)", width: 26 }}>{idx + 1}</td>;
    case "name":
      return (
        <td className="sticky-mgr" style={{ ...st, position: "sticky", left: 0, zIndex: 1, background: "var(--card-bg)", minWidth: 210, boxShadow: "6px 0 8px -6px rgba(0,0,0,.18)" }}>
          <span style={{ display: "inline-block", width: 12, color: "var(--text-muted)", fontSize: 10, transform: isOpen ? "rotate(90deg)" : "none" }}>▸</span>{" "}
          <span style={{ fontWeight: 600 }}>{m.name}</span>
          <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: "var(--r-pill)", background: "var(--info-bg)", color: "var(--info)" }}>
            {m.tag.toUpperCase()}
          </span>
          <div style={{ color: "var(--text-muted)", fontSize: 11, paddingLeft: 18 }}>{m.teamName ?? "Поза командами"}</div>
        </td>
      );
    case "status":
      return (
        <td style={st} title={`${STATUS_LBL[m.status]} · за темпом`}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: `var(${TOKEN[m.status]})` }} />
        </td>
      );
    case "created":
      return (
        <td style={st}>{m.created}{" "}
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            <b style={{ color: "var(--text)", fontWeight: 600 }}>{m.new}</b>/{m.rep}
          </span>
        </td>
      );
    case "ads": return <td style={st}>{m.kpi.ads.fact || none}</td>;
    case "leadgen": return <td style={st}>{m.kpi.leadgen.fact || none}</td>;
    case "conv":
      return <td style={st}>{m.kpi.conversion.fact == null ? none : `${m.kpi.conversion.fact.toFixed(1)}%`}</td>;
    case "dispatch":
      return (
        <td style={st}>{m.kpi.dispatch.fact ?? 0}{" "}
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>/ {m.kpi.dispatch.target > 0 ? m.kpi.dispatch.target : "—"}</span>
        </td>
      );
    case "avgCheck":
      return <td style={st}>{m.kpi.avgCheck.fact == null ? none : `${money(m.kpi.avgCheck.fact)} ₴`}</td>;
    case "fact":
      return <td style={{ ...st, fontWeight: 600 }}>{m.fact ? `${money(m.fact)} ₴` : none}</td>;
    case "plan":
      return <td style={{ ...st, color: "var(--text-muted)" }}>{m.plan ? `${money(m.plan)} ₴` : none}</td>;
    case "pct":
      return <td style={st}>{pctBadge(m.pct)}</td>;
    case "projected":
      // Поза повним поточним місяцем прогнозу НЕМАЄ: бекенд там віддає факт, і
      // показати його як «прогноз» означало б підписати факт чужим словом.
      return <td style={st}>{m.monthInProgress ? `${money(m.projected)} ₴` : none}</td>;
    case "needPerDay":
      return <td style={st}>{m.needPerDay ? `${money(m.needPerDay)} ₴` : none}</td>;
    case "expectThisMonth":
      return <td style={st}>{m.expectThisMonth ? `${money(m.expectThisMonth)} ₴` : none}</td>;
    case "awaitNoDate": {
      const v = m.cohort.awaitNoDateSum;
      return <td style={{ ...st, color: v > 0 ? "var(--danger)" : undefined }}>{v ? `${money(v)} ₴` : none}</td>;
    }
    case "jamDeals": return <td style={st}>{m.jamDeals || none}</td>;
    case "jam": return <td style={st}>{m.jam ? `${money(m.jam)} ₴` : none}</td>;
    case "dobir": return <td style={st}>{m.dobir ? `${money(m.dobir)} ₴` : none}</td>;
    case "talks":
      // 📞 ДВІ ЦИФРИ, НЕ СУМА: розмова (від 10 c) і спроба — різні відповіді.
      return (
        <td style={st}>{m.talks}
          <span style={{ color: "var(--text-muted)" }}> / {m.attempts}</span>
        </td>
      );
    case "dispRevenue":
      return <td style={st}>{m.kpi.dispatch.revenue ? `${K(m.kpi.dispatch.revenue)} ₴` : none}</td>;
    case "responseTime": {
      if (!responseByMgr) return <td style={{ ...st, color: "var(--text-muted)" }}>…</td>;
      const v = responseByMgr.get(m.managerId);
      // `null`/відсутність = «лідів у періоді не було». Це НЕ «жодного повільного».
      if (v == null) return <td style={st} title="вхідних лідів Кваліфікації в періоді не було">{none}</td>;
      // Вище = гірше: тут частка ПРОСТРОЧЕНИХ, а не швидкість.
      const tok = v > 25 ? "--danger" : v >= 10 ? "--warn" : "--ok";
      return <td style={{ ...st, color: `var(${tok})` }}>{v.toFixed(1)}%</td>;
    }
    default:
      return <td style={st}>{none}</td>;
  }
}

function FootCell({ col, rows, scopeLabel, count }: { col: ColDef; rows: ReportPlanManager[]; scopeLabel: string; count: number }) {
  const st: React.CSSProperties = {
    padding: "11px 12px", textAlign: col.left ? "left" : "right", fontWeight: 700, fontSize: 13,
    background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)", whiteSpace: "nowrap",
    ...(col.key === "name" ? { position: "sticky", left: 0, zIndex: 1 } : null),
  };
  if (col.key === "rank") return <td style={st} />;
  if (col.key === "name") return <td style={st}>{scopeLabel} · {count}</td>;
  const f = footValue(col.key, rows);
  if (f.value == null) return <td style={{ ...st, color: "var(--text-muted)", fontWeight: 500 }}>—</td>;
  if (col.key === "pct") return <td style={st}>{f.value}%</td>;
  if (col.key === "conv") return <td style={st}>{f.value.toFixed(1)}%</td>;
  if (col.key === "created") {
    const nw = rows.reduce((s, m) => s + m.new, 0), rp = rows.reduce((s, m) => s + m.rep, 0);
    return <td style={st}>{f.value} <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 500 }}>{nw}/{rp}</span></td>;
  }
  if (col.key === "talks") {
    const at = rows.reduce((s, m) => s + m.attempts, 0);
    return <td style={st}>{f.value}<span style={{ color: "var(--text-muted)", fontWeight: 500 }}> / {at}</span></td>;
  }
  const MONEY_COLS: ColKey[] = ["avgCheck", "fact", "plan", "projected", "needPerDay",
    "expectThisMonth", "awaitNoDate", "jam", "dobir"];
  if (col.key === "dispRevenue") return <td style={st}>{K(f.value)} ₴</td>;
  return <td style={st}>{money(f.value)}{MONEY_COLS.includes(col.key) ? " ₴" : ""}</td>;
}

/**
 * 🗓 РОЗКРИТТЯ РЯДКА — ТИЖНІ МІСЯЦЯ.
 *
 * 🔴 ПІДПИС ПРО ПРИРОДУ ЧИСЛА ОБОВʼЯЗКОВИЙ. `plan` — заморожений знімок; коли він
 * `backfill`, це означає «відновлено ретроспективно з ПОТОЧНОГО стану подій», тож
 * для угод, що відтоді переїхали, число відрізняється від баченого тоді. Приховати
 * цю різницю = тихо збрехати про історію, і саме тому вона їде окремим рядком, а не
 * ховається в підказку.
 *
 * 🔴 ЩО ТУТ СВІДОМО НЕ НАПИСАНО: «сума тижневих планів = місячний план». Це
 * неправда: динамічна ціль рахується від ЗАЛИШКУ на початок тижня, тож Σ тижнів
 * не зобовʼязана сходитись із місяцем. Макет таке твердження містив — прибрано.
 */
function WeeksDrill({ managerId, month }: { managerId: number; month: string }) {
  const [d, setD] = useState<ManagerWeeks | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setD(null); setErr(false);
    fetchManagerWeeks({ managerId, month })
      .then((r) => alive && setD(r))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [managerId, month]);

  if (err) return <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--danger)" }}>Не вдалося завантажити тижні.</div>;
  if (!d) return <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>Завантаження…</div>;

  const anyReconstructed = d.weeks.some((w) => w.reconstructed);
  return (
    <div style={{ padding: "9px 14px 12px 30px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".02em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>
        По тижнях · план зафіксовано в понеділок
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
        <tbody>
          <tr style={{ color: "var(--text-muted)", fontSize: 11 }}>
            <td style={wTd}>Тиждень</td>
            <td style={{ ...wTd, textAlign: "right" }}>Факт</td>
            <td style={{ ...wTd, textAlign: "right" }}>План</td>
            <td style={{ ...wTd, textAlign: "right" }}>Викон.</td>
          </tr>
          {d.weeks.map((w) => (
            <tr key={w.idx}>
              <td style={{ ...wTd, color: "var(--text-muted)" }}>
                {w.from.slice(8)}–{w.to.slice(8)} {w.from.slice(5, 7)}
                <span style={{ opacity: 0.6 }}> · {w.workingDays} р.д.</span>
                {w.reconstructed && <span title="знімок відновлено ретроспективно, а не збережено в момент"
                  style={{ marginLeft: 6, fontSize: 10, color: "var(--warn)" }}>знімок відновлено</span>}
              </td>
              <td style={{ ...wTd, textAlign: "right", fontWeight: 600 }}>{w.fact ? `${money(w.fact)} ₴` : "—"}</td>
              <td style={{ ...wTd, textAlign: "right", color: "var(--text-muted)" }}>
                {w.plan > 0 ? `${money(w.plan)} ₴` : w.overPlan > 0 ? `0 ₴ · понад план +${money(w.overPlan)}` : "—"}
              </td>
              <td style={{ ...wTd, textAlign: "right" }}>
                {w.pct == null ? <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>—</span> : `${w.pct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyReconstructed && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          «Знімок відновлено» — план тижня реконструйовано з поточного стану подій, тож для угод,
          що відтоді переїхали, він відрізняється від баченого тоді.
        </div>
      )}
    </div>
  );
}
const wTd: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px dashed var(--border)", fontSize: 12 };
