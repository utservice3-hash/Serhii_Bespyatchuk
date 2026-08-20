import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchManagerWeeks, type ManagerWeeks, type ReportPlan, type ReportPlanManager, type Team } from "../../../api";
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
  data, teams, auth, teamIds, onTeamIds, periodLabel, hideTeams,
  responseByMgr, month, renderCard,
}: {
  data: ReportPlan;
  teams: Team[];
  auth: { role: string; managerId: number | null; teamId: number | null };
  teamIds: number[];
  onTeamIds: (v: number[]) => void;
  periodLabel: string;
  hideTeams: Set<number>;
  /** Частка лідів >1 год по менеджеру (%). `undefined` — ще вантажиться, `null` — лідів не було. */
  responseByMgr?: Map<number, number | null>;
  /** Місяць для розкриття тижнів (YYYY-MM) — береться від початку обраного періоду. */
  month: string;
  /**
   * ПОВНА КАРТКА обраного менеджера — рендерить КОНТЕЙНЕР, а не таблиця.
   *
   * 🔴 ЧОМУ ПРОПСОМ, А НЕ ІМПОРТОМ. `MgrStrip` живе в `ReportPlanSection`, який сам
   * імпортує цю таблицю. Прямий імпорт назад замкнув би цикл модулів: у ESM він
   * зазвичай «якось працює», але лагодити його потім доводиться в рантаймі, а не
   * на збірці. Виносити `MgrStrip` в окремий файл цим проходом теж не варто — це
   * потягло б за собою пів карткового вигляду, який ми свідомо не чіпаємо.
   */
  renderCard?: (m: ReportPlanManager) => React.ReactNode;
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
    : teamIds.length >= 2 ? `Обрано команд: ${teamIds.length}`
      : teamIds.length === 1 ? "Команда" : "Весь відділ";
  /** 🧩 Групування вмикається САМЕ мультивибором, а не кількістю команд у даних:
      при одній обраній команді екран мусить лишитись байт-у-байт теперішнім. */
  const grouped = teamIds.length >= 2 && mgrFilter === "";
  /**
   * 🔴 ГРУПИ БУДУЮТЬСЯ З ТИХ САМИХ `rows`, ЩО Й ПЛОСКИЙ СПИСОК, і сортуються тим
   * самим `sortRows`. Тому Σ груп == Σ рядків за побудовою, а не за домовленістю
   * (це і стереже `#99`). Порядок груп — як людина їх обрала, а не випадковий.
   */
  const groups = useMemo(() => {
    if (!grouped) return [];
    const byId = new Map<number, ReportPlanManager[]>(teamIds.map((id) => [id, []]));
    const rest: ReportPlanManager[] = [];
    for (const r of rows) {
      const g = r.teamId != null ? byId.get(r.teamId) : undefined;
      if (g) g.push(r); else rest.push(r);
    }
    const out = teamIds.map((id) => ({
      id, name: teams.find((t) => t.id === id)?.name ?? `Команда #${id}`, rows: byId.get(id) ?? [],
    }));
    // 🔴 Рядок, що не потрапив у жодну обрану команду, НЕ зникає: він іде окремою
    // групою з чесною назвою. Мовчазне випадання зробило б Σ груп < Σ рядків, і
    // помітити це можна було б лише склавши стовпчик очима.
    if (rest.length) out.push({ id: -1, name: "Поза обраними командами", rows: rest });
    return out.filter((g) => g.rows.length > 0);
  }, [grouped, rows, teamIds, teams]);

  /**
   * 🔢 ЛІЧИЛЬНИКИ В ОПЦІЯХ — З УЖЕ ЗАВАНТАЖЕНОГО НАБОРУ, без жодного запиту.
   *
   * 🔴 НАСЛІДОК, ЯКИЙ ТРЕБА ЗНАТИ: коли адмін уже звузив вигляд до однієї команди,
   * сервер прислав ЛИШЕ її менеджерів — про склад інших ми в цю мить не знаємо.
   * Тому число стоїть лише там, де воно справді пораховане; решта команд ідуть без
   * лічильника. Написати їм «· 0» означало б стверджувати, що команда порожня, —
   * а це не «нуль», це «ми не дивились».
   */
  const byTeam = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of data.managers) if (r.teamId != null) m.set(r.teamId, (m.get(r.teamId) ?? 0) + 1);
    return m;
  }, [data.managers]);
  const mgrWord = (n: number) => (n === 1 ? "менеджер" : n < 5 ? "менеджери" : "менеджерів");

  return (
    <div>
      {/* ── Обсяг: перевикористовує teamId-механізм Звіту (серверний зріз),
             менеджер фільтрує вже завантажений набір локально. */}
      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Обсяг:</span>
        <ScopePicker
          teams={teams.filter((t) => !hideTeams.has(t.id))}
          isAdmin={auth.role === "admin"}
          teamIds={teamIds} onTeamIds={onTeamIds}
          mgrFilter={mgrFilter} onMgrFilter={setMgrFilter}
          managers={data.managers} byTeam={byTeam}
          allLabel={`Весь відділ · ${data.managers.length} ${mgrWord(data.managers.length)}`}
        />
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {rows.length} {rows.length === 1 ? "рядок" : rows.length < 5 ? "рядки" : "рядків"} · {periodLabel}
        </span>
      </div>

      {/* 🔴 ПІДПИС ЗВУЖЕННЯ (рішення власника 20.08.2026, варіант «б»).
             Верхній підсумок (кільце, плитки) рендериться КОНТЕЙНЕРОМ до розвилки
             вигляду, тож фільтр менеджера його не звужує. Числа там не брешуть —
             але без цього рядка вони читаються як «підсумок обраного».
             Перераховувати `glance` на фронті свідомо НЕ стали: це завело б другий
             обчислювач тих самих чисел, тобто рівно те, від чого береже #81. */}
      {mgrFilter !== "" && (
        <div style={{
          fontSize: 12, color: "var(--text-muted)", marginBottom: 12, padding: "8px 12px",
          background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
        }}>
          Підсумок угорі — <b style={{ color: "var(--text)" }}>по всьому відділу</b>; нижче — лише
          обраний менеджер.
        </div>
      )}

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

      {/**
        * 🧍 ОДИН МЕНЕДЖЕР — ПОВНА КАРТКА (рішення власника 20.08.2026).
        *
        * Вибір одного менеджера в «Обсяг» і Є запитом «покажи все про нього», тож
        * картка стоїть РОЗГОРНУТОЮ і стан `open` таблиці з нею не ділиться: інакше
        * «розгорнув у таблиці — згорнулось у картці» стало б питанням часу.
        *
        * 🔴 Це ТОЙ САМИЙ `MgrStrip`, що в картковому вигляді, а не його копія: копія
        * розійшлася б із оригіналом мовчки — рівно те, від чого береже #81.
        */}
      {mgrFilter !== "" && renderCard && rows[0] && (
        <div style={{ marginBottom: 14 }}>{renderCard(rows[0])}</div>
      )}

      <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table rpt-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr>
                {cols.map((c, i) => (
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
                    {c.help && <HelpDot text={c.help} title={c.title} alignRight={i > cols.length / 2} />}
                    {c.key !== "rank" && (
                      <span style={{ marginLeft: 3, fontSize: 9, opacity: c.key === sortKey ? 1 : 0.35 }}>
                        {c.key === sortKey ? (sortDir === -1 ? "▼" : "▲") : "↕"}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            {(grouped ? groups : [{ id: 0, name: "", rows }]).map((g) => (
            <tbody key={`g${g.id}`}>
              {grouped && (
                <tr>
                  <td colSpan={cols.length} className="sticky-mgr"
                      style={{ position: "sticky", left: 0, background: "var(--surface-2)",
                        padding: "9px 12px", fontSize: 11.5, fontWeight: 800, letterSpacing: ".04em",
                        textTransform: "uppercase", color: "var(--brand)",
                        borderTop: "2px solid var(--border-strong)" }}>
                    {g.name} <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>· {g.rows.length}</span>
                  </td>
                </tr>
              )}
              {g.rows.map((m, i) => (
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
              {grouped && (
                <tr>
                  {cols.map((c) => (
                    <FootCell key={c.key} col={c} rows={g.rows} scopeLabel={`Команда · ${g.name}`} count={g.rows.length} group />
                  ))}
                </tr>
              )}
              {rows.length === 0 && (
                <tr><td colSpan={cols.length} style={{ padding: 20, color: "var(--text-muted)" }}>
                  Немає менеджерів у цьому розрізі.
                </td></tr>
              )}
            </tbody>
            ))}
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
      // 🔀 Counts ЗАВЖДИ, % лише при взято ≥10 (рішення власника 21.08.2026) — однаково
      // в усіх трьох колонках. Combined свого ЗНАЧЕННЯ не змінює: додались лише видимі
      // взято/виграно, яких раніше не було (доводить `#101`).
      return <td style={st}>{convCell(m.kpi.conversion.fact, m.kpi.conversion.won ?? 0, m.kpi.conversion.taken ?? 0)}</td>;
    case "convAd":
      return <td style={st}>{convCell(m.conversionAd.fact, m.conversionAd.won, m.conversionAd.taken)}</td>;
    case "convLg":
      return <td style={st}>{convCell(m.conversionLeadgen.fact, m.conversionLeadgen.won, m.conversionLeadgen.taken)}</td>;
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
    case "srcAd": return <td style={st}>{m.srcAd || none}</td>;
    case "srcLeadgen": return <td style={st}>{m.srcLeadgen || none}</td>;
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

function FootCell({ col, rows, scopeLabel, count, group }: { col: ColDef; rows: ReportPlanManager[]; scopeLabel: string; count: number;
  /** Підсумок ГРУПИ (команди) всередині таблиці — тонший, ніж загальний унизу. */
  group?: boolean }) {
  const st: React.CSSProperties = {
    padding: group ? "8px 12px" : "11px 12px", textAlign: col.left ? "left" : "right",
    fontWeight: 700, fontSize: group ? 12.5 : 13,
    background: group ? "var(--surface-2)" : "var(--surface-2)",
    borderTop: `${group ? 1 : 2}px solid var(--border-strong)`, whiteSpace: "nowrap",
    ...(col.key === "name" ? { position: "sticky", left: 0, zIndex: 1 } : null),
  };
  if (col.key === "rank") return <td style={st} />;
  if (col.key === "name") return <td style={st}>{scopeLabel} · {count}</td>;
  const f = footValue(col.key, rows);
  if (f.value == null) return <td style={{ ...st, color: "var(--text-muted)", fontWeight: 500 }}>—</td>;
  if (col.key === "pct") return <td style={st}>{f.value}%</td>;
  if (col.key === "conv" || col.key === "convAd" || col.key === "convLg") {
    const e = f.extra as { num: number; den: number } | undefined;
    return (
      <td style={st}>{f.value.toFixed(1)}%
        {e ? <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 500 }}> {e.num}/{e.den}</span> : null}
      </td>
    );
  }
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
 * ❓ ПОЯСНЕННЯ КОЛОНКИ — hover, ФОКУС, тап; клік ПРИШПИЛЮЄ.
 *
 * 🔴 ЧОМУ НЕ `title=""`. Атрибут не показується на тачі, не відкривається з
 * клавіатури і не існує для гейта як видимий текст — на цьому ми вже ловились у
 * #85b. Тому це справжній елемент: `role="button"`, `tabIndex=0`, Enter/Пробіл.
 *
 * 🔴 ЧОМУ ПОРТАЛ У BODY, А НЕ `position:absolute` У ЗАГОЛОВКУ. Таблиця лежить у
 * контейнері з `overflow-x:auto`, а це за специфікацією робить НЕ-visible і другу
 * вісь: вікно, що виходить за межі контейнера, обрізається — і найдужче саме там,
 * де воно найпотрібніше (крайні праві колонки, куди треба скролити). Портал із
 * `position:fixed` виносить вікно з-під обрізання зовсім; координати беруться від
 * кнопки і перераховуються на скролі, щоб підказка не «відклеїлась».
 *
 * 🔴 ЧОМУ КЛІК ПРИШПИЛЮЄ. Наведенням вікно зникало, щойно курсор рушав до тексту —
 * тобто прочитати довге пояснення було неможливо, і власник це й побачив. Тепер
 * клік фіксує вікно до Escape або кліку поза ним, а наведення лишається швидким
 * способом зазирнути.
 *
 * 🔴 КЛІК ЗУПИНЯЄТЬСЯ: заголовок сортує таблицю, тож без `stopPropagation` спроба
 * прочитати пояснення перевертала б сортування — дія, якої людина не просила.
 */
function HelpDot({ text, title, alignRight }: { text: string; title: string; alignRight?: boolean }) {
  const [open, setOpen] = useState(false);
  /** Клік/тап ПРИШПИЛЮЄ: поки читаєш — вікно стоїть. Наведення так не робить. */
  const [pinned, setPinned] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; right: number } | null>(null);
  const btn = useRef<HTMLSpanElement | null>(null);

  const measure = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setBox({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right });
  };
  const show = () => { measure(); setOpen(true); };
  const hide = () => { if (!pinned) setOpen(false); };
  const close = () => { setPinned(false); setOpen(false); };
  const stop = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault(); e.stopPropagation();
  };

  // Пришпилене вікно закриває Escape або клік ПОЗА ним — як і будь-який поп-ап,
  // що перекриває вміст. Слухачі живуть лише поки вікно відкрите.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!btn.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // Позиція фіксована відносно вікна, тож при скролі її треба перерахувати —
    // інакше підказка «відклеїться» від свого заголовка.
    const onMove = () => (pinned ? measure() : close());
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, pinned]);

  return (
    <span style={{ position: "relative", display: "inline-flex", marginLeft: 4, verticalAlign: "middle" }}>
      <span
        ref={btn}
        role="button"
        tabIndex={0}
        aria-label={`Що означає «${title}» і звідки береться`}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { stop(e); if (pinned) close(); else { setPinned(true); show(); } }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { stop(e); if (pinned) close(); else { setPinned(true); show(); } }
          if (e.key === "Escape") close();
        }}
        style={{
          cursor: "help", fontSize: 12, lineHeight: 1,
          color: open ? "var(--brand)" : "var(--text-muted)",
          border: `1px solid ${pinned ? "var(--brand)" : "var(--border)"}`, borderRadius: "var(--r-pill)",
          width: 15, height: 15, display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontWeight: 700, background: "var(--card-bg)",
        }}
      >?</span>
      {open && box && createPortal(
        <span
          role="tooltip"
          onClick={stop}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={hide}
          style={{
            position: "fixed", top: box.top, zIndex: 60,
            ...(alignRight ? { right: box.right } : { left: box.left }),
            width: "max-content", maxWidth: "min(320px, 92vw)",
            background: "var(--card-bg)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
            boxShadow: "var(--shadow-lg)", padding: "9px 11px",
            fontSize: 12, fontWeight: 400, lineHeight: 1.45,
            textTransform: "none", letterSpacing: 0, whiteSpace: "normal", textAlign: "left",
          }}
        >
          {text}
          {pinned && (
            <span style={{ display: "block", marginTop: 6, color: "var(--text-muted)", fontSize: 11 }}>
              Esc або клік поза вікном — закрити
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
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
/**
 * 🧩 «ОБСЯГ» — ОДИН КОНТРОЛ НА ТРИ ВЗАЄМОВИКЛЮЧНІ РЕЖИМИ (21.08.2026).
 *
 * Весь відділ · кілька команд галочками · один менеджер. Режими взаємно
 * скидаються: обрав менеджера — команди знято, поставив галочку — менеджера знято.
 * Інакше екран показував би перетин двох фільтрів, якого людина не просила, і
 * порожній результат читався б як «немає даних», а не як «фільтри б'ються».
 *
 * 🔴 ЧОМУ НЕ `<select multiple>`: нативний мультиселект вимагає Ctrl+клік, а без
 * нього мовчки СКИДАЄ попередній вибір. Тобто найпростіша дія — клікнути другу
 * команду — дала б протилежний результат очікуваному.
 */
/**
 * 🔀 КЛІТИНКА КОНВЕРСІЇ — ОДНА ФОРМА НА ВСІ ТРИ КОЛОНКИ (21.08.2026).
 *
 * Взято/виграно показуються ЗАВЖДИ, відсоток — лише при взято ≥ 10. Заміряно за
 * серпень: після розділення за джерелом поріг лишив би «Конв. лідоген» порожньою
 * у 22 із 31 менеджера, а екран із трьох чвертей прочерків читається як зламаний.
 * Числа при цьому не брешуть при жодній вибірці — брехав би саме відсоток, тому
 * поріг стоїть рівно там, де стояв.
 */
function convCell(pct: number | null, won: number, taken: number) {
  if (taken === 0) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <>
      {pct == null ? <span style={{ color: "var(--text-muted)" }}>—</span> : `${pct.toFixed(1)}%`}
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}> {won}/{taken}</span>
    </>
  );
}

function ScopePicker({ teams, isAdmin, teamIds, onTeamIds, mgrFilter, onMgrFilter, managers, byTeam, allLabel }: {
  teams: Team[]; isAdmin: boolean;
  teamIds: number[]; onTeamIds: (v: number[]) => void;
  mgrFilter: number | ""; onMgrFilter: (v: number | "") => void;
  managers: ReportPlanManager[]; byTeam: Map<number, number>; allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const label = mgrFilter !== "" ? (managers.find((m) => m.managerId === mgrFilter)?.name ?? "Менеджер")
    : teamIds.length === 0 ? allLabel
      : teamIds.length === 1 ? (teams.find((t) => t.id === teamIds[0])?.name ?? "Команда")
        : `${teamIds.length} команди · ${managers.length} ${managers.length === 1 ? "менеджер" : managers.length < 5 ? "менеджери" : "менеджерів"}`;

  const toggleTeam = (id: number) => {
    onMgrFilter("");
    onTeamIds(teamIds.includes(id) ? teamIds.filter((x) => x !== id) : [...teamIds, id]);
  };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 11px", cursor: "pointer", fontSize: 13 };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ ...selStyle, cursor: "pointer", textAlign: "left", minWidth: 210 }}>
        {label} <span style={{ opacity: 0.5, marginLeft: 4 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 60, minWidth: 280, maxHeight: 420,
          overflowY: "auto", background: "var(--card-bg)", border: "1px solid var(--border-strong)",
          borderRadius: "var(--r-md)", boxShadow: "var(--shadow)", padding: "5px 0",
        }}>
          <div style={{ ...row, fontWeight: teamIds.length === 0 && mgrFilter === "" ? 700 : 400 }}
               onClick={() => { onMgrFilter(""); onTeamIds([]); setOpen(false); }}>
            <span style={{ width: 14 }}>{teamIds.length === 0 && mgrFilter === "" ? "•" : ""}</span>{allLabel}
          </div>
          {isAdmin && teams.length > 0 && (
            <>
              <div style={{ padding: "7px 11px 3px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)" }}>
                Команди — можна кілька
              </div>
              {teams.map((t) => {
                const n = byTeam.get(t.id);
                return (
                  <label key={t.id} style={row}>
                    <input type="checkbox" checked={teamIds.includes(t.id)} onChange={() => toggleTeam(t.id)} />
                    {t.name}{n != null ? <span style={{ color: "var(--text-muted)" }}> · {n}</span> : null}
                  </label>
                );
              })}
            </>
          )}
          <div style={{ padding: "7px 11px 3px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)" }}>
            Один менеджер
          </div>
          {managers.map((m) => (
            <div key={m.managerId} style={{ ...row, fontWeight: mgrFilter === m.managerId ? 700 : 400 }}
                 onClick={() => { onTeamIds([]); onMgrFilter(m.managerId); setOpen(false); }}>
              <span style={{ width: 14 }}>{mgrFilter === m.managerId ? "•" : ""}</span>{m.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".02em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 3 }}>
        По тижнях · план зафіксовано в понеділок
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 7, maxWidth: 640, lineHeight: 1.45 }}>
        План тижня зафіксовано в понеділок (weekly_plan_snapshots); де «знімок відновлено» —
        реконструйовано ретроспективно. Факт — каса ② по днях тижня.
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
        <tbody>
          <tr style={{ color: "var(--text-muted)", fontSize: 11 }}>
            <td style={wTd}>Тиждень</td>
            <td style={{ ...wTd, textAlign: "right" }}>Факт</td>
            <td style={{ ...wTd, textAlign: "right" }}>План</td>
            <td style={{ ...wTd, textAlign: "right" }}>Викон.</td>
            <td style={{ ...wTd, textAlign: "right" }}>Авто ф/ц</td>
          </tr>
          {d.weeks.map((w) => (
            <tr key={w.idx}>
              <td style={{ ...wTd, color: "var(--text-muted)" }}>
                {w.from.slice(8)}–{w.to.slice(8)} {w.from.slice(5, 7)}
                <span style={{ opacity: 0.6 }}> · {w.workingDays} р.д.</span>
                {w.clipped && <span title="тиждень обрізаний межею місяця — коротший за повний Пн–Нд; тижнева ЦІЛЬ на картці рахується по повному календарному тижню"
                  style={{ marginLeft: 6, fontSize: 10, color: "var(--text-muted)" }}>обрізаний місяцем</span>}
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
              <td style={{ ...wTd, textAlign: "right" }}>
                {w.dispatchFact}
                <span style={{ color: "var(--text-muted)" }}> / {w.dispatchTarget ?? "—"}</span>
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
