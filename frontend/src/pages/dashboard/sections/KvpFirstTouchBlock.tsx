import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAiCalls, type AiCallsResp } from "../../../api";
import { InfoHint } from "../widgets";
import { AI_START_DATE, firstTouchSummary, summaryTeams, aiCallsHref, fmtMinutes, medianMin, TILE_MATCH,
  SUCCESS_MIN_FOR_PCT, type ChecklistLine, type TileKey } from "../aiCallsView";
import { sortFtLines, tileCountsByManager, type FtSortKey } from "../kvpCoreRules";
import "./firstTouch.css";

/**
 * 🎧 «ПЕРШИЙ ДОТИК» У ЗВІТІ КВП (задача 5314, макет «Звіт КВП - ядро з першим дотиком», TOP Weekly 08.10.2026):
 * «важливі цифри зверху великими, і щоб по кліку було видно, які саме розмови».
 *
 * 🔴 Своїх формул тут НЕМАЄ: ті самі рядки `/ai-calls` за період Звіту і `firstTouchSummary` — та сама вкладка «Звіт»,
 * той самий фільтр при відкритті, ті самі `tileStats` / `managerChecklist`, що на екрані «Перший дотик · AI». Тому
 * картки дорівнюють екрану, а рядок команди — екрану з вибраною цією командою. Клік — на екран AI з тим самим
 * періодом і фільтром.
 * 🏆 Ядро Звіту КВП (задача 5605, ТЗ 12.10, розділ 4): клік по картці тепер ФІЛЬТРУЄ таблицю нижче (повторний — знімає),
 * є фільтр «Команда», «Скинути» і сортування кожної колонки; на екран AI веде «Відкрити ›» і клік по імені. «Клієнт погодився» (задача 5316, на проді з 13.10.2026) — та сама статистика плиток (`decision`) і ті
 * самі лічильники рядка менеджерів, що на екрані: лише розмови, де ціну назвали; «думає» видно окремо.
 */
const C = { ok: "#16a34a", bad: "#dc2626", muted: "var(--text-muted)" };
const pctStr = (v: number | null) => (v == null ? "—" : `${String(v)}%`);

export function KvpFirstTouchBlock({ from, to }: { from: string; to: string }) {
  const navigate = useNavigate();
  const [d, setD] = useState<AiCallsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setD(null); setErr(null);
    fetchAiCalls({ from, to }).then((x) => { if (alive) setD(x); }).catch(() => { if (alive) setErr("Не вдалося завантажити «Перший дотик»."); });
    return () => { alive = false; };
  }, [from, to]);
  const all = useMemo(() => (d ? firstTouchSummary(d.rows) : null), [d]);
  const [tile, setTile] = useState<TileKey | null>(null);
  const [teamSel, setTeamSel] = useState<string>("all");
  const [sort, setSort] = useState<{ key: FtSortKey; dir: "asc" | "desc" } | null>(null);
  const reset = () => { setTile(null); setTeamSel("all"); setSort(null); };
  const teams = useMemo(() => (d && all ? summaryTeams(all.rows).map((t) => ({ ...t, s: firstTouchSummary(d.rows, t.id) })) : []), [d, all]);

  const open = (p: { tile?: TileKey | null; teamId?: number | null; managerId?: number | null }) => navigate(aiCallsHref({ from, to, ...p }));
  const teamIdSel = teamSel === "all" ? undefined : teamSel === "none" ? null : Number(teamSel);
  const head = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
      <h2 className="chart-title" style={{ margin: 0 }}>🎧 Перший дотик — якість перших розмов з реклами
        <InfoHint text="AI слухає першу розмову менеджера з кожною рекламною заявкою. Цифри — рівно ті, що на екрані «Перший дотик · AI» за той самий період (за датою створення угоди). Клік по картці — фільтр таблиці нижче (повторний — знімає); клік по імені — на екран AI з тим самим фільтром." /></h2>
      <button type="button" onClick={() => open({ tile, ...(teamIdSel === undefined ? {} : { teamId: teamIdSel }) })} style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer", fontSize: 13 }}>Відкрити «Перший дотик · AI» ›</button>
    </div>
  );
  if (err) return <div className="chart-card">{head}<p style={{ color: C.bad, margin: "8px 0 0" }}>{err}</p></div>;
  if (!d || !all) return <div className="chart-card">{head}<p className="loading-text" style={{ margin: "8px 0 0" }}>Завантаження…</p></div>;

  const ts = all.tiles, target = d.priceTargetPct;
  const lost = all.rows.filter(TILE_MATCH.lost);
  const lostReact = medianMin(lost.map((r) => r.reactionMin));
  const card = (k: TileKey | null, label: string, value: string, sub: string, tone: "bad" | "ok" | "" = "") => {
    const body = (<>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <b style={{ display: "block", fontSize: 26, margin: "4px 0 2px", fontVariantNumeric: "tabular-nums", color: tone === "bad" ? C.bad : tone === "ok" ? C.ok : k ? "inherit" : C.muted }}>{value}</b>
      <span style={{ fontSize: 12, color: C.muted }}>{sub}</span>
    </>);
    const on = k != null && tile === k;
    const st: React.CSSProperties = { textAlign: "left", font: "inherit", color: "inherit", background: "var(--card-bg, #fff)", border: on ? "2px solid #2563eb" : "1px solid var(--border, #e5e7eb)", borderRadius: 10, padding: on ? "9px 11px" : "10px 12px", minWidth: 0 };
    return k
      ? <button key={label} type="button" aria-pressed={on} onClick={() => setTile(on ? null : k)} title={on ? "Зняти фільтр" : "Показати в таблиці менеджерів із такими розмовами"} style={{ ...st, cursor: "pointer" }}>{body}</button>
      : <div key={label} style={st}>{body}</div>;
  };
  const cell = (v: number | null, goal: number | null = null) => (
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: goal != null && v != null ? (v >= goal ? C.ok : C.bad) : undefined }}>{pctStr(v)}</td>
  );
  /** Міні-смужка частки — той самий `.ftd-bar`, що на екрані «Перший дотик · AI» (макет «Звіт КВП - ядро»): зелена — у нормі, рожева — нижче. */
  const bar = (v: number | null, goal: number) => (
    <td style={{ textAlign: "right" }}>{v == null ? "—" : (
      <div className={`ftd-bar ${v >= goal ? "is-ok" : "is-bad"}`} style={{ minWidth: 96, marginLeft: "auto" }}>
        <i style={{ width: `${String(Math.max(0, Math.min(100, v)))}%` }} /><span style={{ fontWeight: 600 }}>{v}%</span>
      </div>)}</td>
  );
  const sig = (l: ChecklistLine) => [
    l.price != null && l.price < target ? `ціна нижче ${String(target)}%` : null,
    l.promise != null && l.promise < 50 ? "обіцянки зриває" : null,
  ].filter((x): x is string => x != null);
  // `link` — куди веде клік; `null` — нікуди: розмов «без команди» екран AI окремим фільтром не показує.
  const row = (l: ChecklistLine, kind: "team" | "mgr", teamId: number | null, link: Parameters<typeof open>[0] | null, hits?: number) => (
    <tr key={`${kind}:${String(teamId)}:${String(l.managerId)}`} style={kind === "team" ? { background: "var(--bg, #f6f6f7)", fontWeight: 700 } : undefined}>
      <td>
        {link
          ? <button type="button" onClick={() => open(link)} title="Відкрити на екрані «Перший дотик · AI»"
              style={{ border: "none", background: "none", padding: kind === "team" ? 0 : "0 0 0 14px", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>{l.name}</button>
          : <span>{l.name}</span>}
        {hits != null && <span style={{ marginLeft: 6, fontSize: 11, padding: "0 6px", borderRadius: 10, background: "rgba(37,99,235,.12)", color: "#2563eb" }} title="розмов цієї картки">{hits}</span>}
      </td>
      <td style={{ textAlign: "right" }}>{l.calls}</td>
      {cell(l.score)}{bar(l.price, target)}{bar(l.promise, 50)}
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{l.objections ? `${pctStr(l.objection)} · ${String(l.objectionsHandled)}/${String(l.objections)}` : "—"}</td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} title={l.decided ? `Погодився ${String(l.agreed)} з ${String(l.decided)} після ціни · думає ${String(l.thinking)}` : "Згода після ціни розбирається для розмов від 13.10, де назвали ціну"}>
        {l.decided ? `${pctStr(Math.round((l.agreed / l.decided) * 100))} · ${String(l.agreed)}/${String(l.decided)}` : "—"}</td>
      <td style={{ textAlign: "right" }}>{l.success} з {l.calls}</td>
      <td style={{ paddingLeft: 14 }}>{kind === "mgr" && sig(l).map((t) => <span key={t} style={{ display: "inline-block", fontSize: 11, padding: "1px 6px", borderRadius: 10, marginRight: 4, background: "rgba(220,38,38,.12)", color: C.bad }}>{t}</span>)}</td>
    </tr>
  );

  // 🔎 Фільтр картки, команди й сортування — над тими самими рядками; підсумки команд і відділу не перераховуються.
  const hits = tileCountsByManager(all.rows, tile ? TILE_MATCH[tile] : null);
  const shownTeams = teams
    .filter((t) => teamIdSel === undefined || t.id === teamIdSel)
    .map((t) => ({ ...t, lines: sortFtLines(t.s.lines.filter((l) => !hits || (hits.get(l.managerId) ?? 0) > 0), sort?.key ?? null, sort?.dir ?? "desc") }))
    .filter((t) => t.lines.length > 0);
  const th = (k: FtSortKey, label: string) => (
    <th style={{ textAlign: "right", cursor: "pointer", whiteSpace: "nowrap" }} aria-sort={sort?.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => setSort(sort?.key === k ? (sort.dir === "desc" ? { key: k, dir: "asc" } : null) : { key: k, dir: "desc" })}
      title="Сортувати">{label}{sort?.key === k ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}</th>
  );

  return (
    <div className="chart-card">
      {head}
      {from < AI_START_DATE && <p style={{ fontSize: 12, color: C.muted, margin: "4px 0 0" }}>Аналіз розмов — з {AI_START_DATE.split("-").reverse().join(".")}; раніших розмов у цих цифрах немає.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, margin: "10px 0 12px" }}>
        {card("noPrice", "Ціна озвучена", pctStr(ts.price.pct), `${String(ts.price.yes)} з ${String(ts.price.of)} · ціль ${String(target)}%`, ts.price.pct == null ? "" : ts.price.pct >= target ? "ok" : "bad")}
        {card("noCall", "Обіцяли — дзвінка в телефонії немає", String(ts.noCall.n), `${ts.noCall.of ? `${String(Math.round((ts.noCall.n / ts.noCall.of) * 100))}% від ` : "з "}${String(ts.noCall.of)} обіцянок`, ts.noCall.n > 0 ? "bad" : "")}
        {card("objNotHandled", "Заперечення опрацьовано", pctStr(ts.objection.pct), ts.objection.of ? `${String(ts.objection.handled)} з ${String(ts.objection.of)} заперечень` : "розбираються для розмов від 09.10")}
        {card(ts.decision.of ? "agreed" : null, "Клієнт погодився", pctStr(ts.decision.pct),
          ts.decision.of ? `${String(ts.decision.agreed)} з ${String(ts.decision.of)} після ціни · думає ${String(ts.decision.thinking)} · відмовив ${String(ts.decision.declined)}`
            : "розбирається для розмов від 13.10, де назвали ціну")}
        {card("success", "Поїхало", `${String(ts.success.n)} з ${String(ts.success.of)}`, ts.success.n >= SUCCESS_MIN_FOR_PCT ? `${String(Math.round((ts.success.n / Math.max(1, ts.success.of)) * 100))}% угод · «Авто працює» і далі` : "угода в «Авто працює» і далі")}
        {card("lost", "Втрачені ліди", String(lost.length), lostReact == null ? "реакція — немає даних" : `реакція (медіана) ${fmtMinutes(lostReact)}`)}
      </div>
      {/* Фільтр «Команда», «Скинути» — ті самі елементи, що на екрані «Перший дотик · AI». */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px" }}>
        <select value={teamSel} onChange={(e) => setTeamSel(e.target.value)} aria-label="Команда">
          <option value="all">Усі команди</option>
          {teams.map((t) => <option key={String(t.id)} value={t.id == null ? "none" : String(t.id)}>{t.name}</option>)}
        </select>
        <button type="button" onClick={reset} disabled={!tile && teamSel === "all" && !sort}>Скинути</button>
        <span style={{ fontSize: 12, color: C.muted }}>менеджерів у таблиці: {shownTeams.reduce((a, t) => a + t.lines.length, 0)}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ minWidth: 860 }}>
          <thead><tr>
            <th>Команда / менеджер</th>{th("calls", "Розмов")}{th("score", "Бал")}
            {th("price", `Ціна · ціль ${String(target)}%`)}{th("promise", "Обіцянка")}
            {th("objection", "Заперечення")}{th("agreed", "Погодився")}
            {th("success", "Поїхало")}<th style={{ paddingLeft: 14 }}>Що не так</th>
          </tr></thead>
          <tbody>
            {shownTeams.map((t) => t.s.total && [
              row({ ...t.s.total, name: t.name }, "team", t.id, t.id == null ? null : { teamId: t.id }),
              ...t.lines.map((l) => row(l, "mgr", t.id, l.managerId == null ? null : { teamId: t.id, managerId: l.managerId }, hits?.get(l.managerId))),
            ])}
            {all.total && teamSel === "all" && !tile && row({ ...all.total, name: "Разом по відділу" }, "team", null, {})}
          </tbody>
        </table>
      </div>
      {tile && shownTeams.length === 0 && <p style={{ fontSize: 13, color: C.muted, margin: "6px 0 0" }}>Розмов цієї картки за період немає.</p>}
      {!all.total && <p style={{ fontSize: 13, color: C.muted, margin: "6px 0 0" }}>Розібраних перших розмов за цей період ще немає.</p>}
    </div>
  );
}
