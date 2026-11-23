import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAiCalls, type AiCallsResp } from "../../../api";
import { InfoHint } from "../widgets";
import { AI_START_DATE, firstTouchSummary, aiCallsHref, fmtMinutes, medianMin, TILE_MATCH,
  SUCCESS_MIN_FOR_PCT, type TileKey } from "../aiCallsView";
import "./firstTouch.css";

/**
 * 🎧 «ПЕРШИЙ ДОТИК» У ЗВІТІ КВП (задача 5314, макет «Звіт КВП - ядро з першим дотиком», TOP Weekly 08.10.2026):
 * «важливі цифри зверху великими, і щоб по кліку було видно, які саме розмови».
 *
 * 🔴 Своїх формул тут НЕМАЄ: ті самі рядки `/ai-calls` за період Звіту і `firstTouchSummary` — та сама вкладка «Звіт»,
 * той самий фільтр при відкритті, ті самі `tileStats` / `managerChecklist`, що на екрані «Перший дотик · AI». Тому
 * картки дорівнюють екрану, а рядок команди — екрану з вибраною цією командою. Клік — на екран AI з тим самим
 * періодом і фільтром.
 * ✂️ Правки зустрічі 17.11.2026: таблицю «Команда / менеджер» прибрано як дубль екрана «Перший дотик · AI» — лишились
 * великі цифри якості й кількості; клік по картці відкриває екран AI з цим фільтром. Було (5605, ТЗ 12.10, розділ 4): клік по картці ФІЛЬТРУВАВ таблицю нижче (повторний — знімає),
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
  const open = (p: { tile?: TileKey | null; teamId?: number | null; managerId?: number | null }) => navigate(aiCallsHref({ from, to, ...p }));
  const head = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
      <h2 className="chart-title" style={{ margin: 0 }}>🎧 Перший дотик — якість перших розмов з реклами
        <InfoHint text="AI слухає першу розмову менеджера з кожною рекламною заявкою. Цифри — рівно ті, що на екрані «Перший дотик · AI» за той самий період (за датою створення угоди). Клік по картці — фільтр таблиці нижче (повторний — знімає); клік по імені — на екран AI з тим самим фільтром. Новачки в перші 4 тижні від прийому в ці цифри не входять — їх видно на екрані «Перший дотик · AI», блок «На адаптації»." /></h2>
      <button type="button" onClick={() => open({})} style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer", fontSize: 13 }}>Відкрити «Перший дотик · AI» ›</button>
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
    const st: React.CSSProperties = { textAlign: "left", font: "inherit", color: "inherit", background: "var(--card-bg, #fff)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 10, padding: "10px 12px", minWidth: 0 };
    return k
      ? <button key={label} type="button" onClick={() => open({ tile: k })} title="Відкрити ці розмови на екрані «Перший дотик · AI»" style={{ ...st, cursor: "pointer" }}>{body}</button>
      : <div key={label} style={st}>{body}</div>;
  };
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
      {!all.total && <p style={{ fontSize: 13, color: C.muted, margin: "6px 0 0" }}>Розібраних перших розмов за цей період ще немає.</p>}
      {/* ✂️ Рядок «На адаптації…» прибрано (задача 10753, 23.11.2026): новачків видно на екрані «Перший дотик · AI», тут — лише фраза в підказці (i). */}
    </div>
  );
}
