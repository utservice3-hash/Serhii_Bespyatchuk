import { useEffect, useMemo, useState } from "react";
import { fetchMissedCalls, type MissedCallsResp, type MissedDayBucket, type MissedManagerRow } from "../../../api";
import { InfoHint } from "../widgets";

/**
 * 📵 «ПРОПУЩЕНІ ДЗВІНКИ» — ТЗ-1 від 14.09.2026, блоки A (підсумок) і B (по менеджерах).
 *
 * Замінює ручний збір: доти Юля щодня збирала пропущені сама й кидала в чат «Керівники».
 * Усі означення — рішення власника 15.09.2026, закриті гейтами `#431`-`#440` на бекенді:
 * BUSY рахується, CLIENT NO ANSWER — ні; передзвін у вікні 24 год будь-ким; плечі одного
 * дзвінка склеєні.
 *
 * 🔴 «БЕЗ ВІДПОВІДАЛЬНОГО» — ПОЛОВИНА ПРЕДМЕТА, І ВОНА НЕ ХОВАЄТЬСЯ. Правило фронту:
 * коли невідомих БІЛЬШІСТЬ, прогалина стає числом у шапці, а не підписом у кожному рядку.
 * Тому тут обидва: плитка в блоці A і один чесний рядок у таблиці B.
 */

/** Порядок і підписи відер — ті самі, що в ядрі (`core/dayBuckets.ts`, `DAY_BUCKETS`). */
const BUCKETS: { key: MissedDayBucket; label: string; hint: string }[] = [
  { key: "work", label: "Робочий час", hint: "Будні 9:00–18:00 за Києвом." },
  { key: "evening", label: "Вечір", hint: "Будні 18:00–21:00 за Києвом." },
  { key: "weekend", label: "Вихідні", hint: "Субота й неділя цілу добу. Державні свята НЕ враховуються — календар свят порожній, тож свято в будній день рахується як звичайний день." },
  { key: "night", label: "Ніч", hint: "Будні 21:00–9:00 за Києвом." },
];

type SortKey = "missed" | "callbackSelf" | "callbackColleague" | "noCallback" | "medianMin" | "clientSelf";

/** «—», а не «0 %»: нульовий знаменник — це «нема з чого рахувати», а не провал. */
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export function MissedCallsSection({ from, to }: { from: string; to: string }) {
  const [d, setD] = useState<MissedCallsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("missed");

  useEffect(() => {
    // Швидкий період «Весь час» шле ПОРОЖНІ рядки; сервер підставить 30 днів, але
    // тоді на екрані стояв би період, якого не обирали. Чекаємо справжній.
    if (!from || !to) return;
    setD(null); setErr(null);
    fetchMissedCalls({ from, to })
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : "Не вдалося завантажити"));
  }, [from, to]);

  /**
   * Сортуємо лише ЛЮДЕЙ. «Без відповідального» лишається внизу за будь-якого сортування:
   * це не людина, і поставити «нікого» на перше місце рейтингу означало б сказати
   * неправду про роботу відділу — саме так упорядковує і ядро (`foldManagerRows`).
   */
  const rows = useMemo(() => {
    if (!d) return [] as MissedManagerRow[];
    const people = d.managers.filter((r) => r.managerId !== null);
    const ownerless = d.managers.filter((r) => r.managerId === null);
    const val = (r: MissedManagerRow) => r[sort] ?? -1;
    people.sort((a, b) => val(b) - val(a) || a.name.localeCompare(b.name, "uk"));
    return [...people, ...ownerless];
  }, [d, sort]);

  if (err) return <div className="chart-card"><p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const s = d.summary;
  const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" };
  const cols: { key: SortKey; label: string; hint: string }[] = [
    { key: "missed", label: "Пропущено", hint: "Вхідні без розмови з відповіддю NO ANSWER або BUSY, плечі одного дзвінка склеєні." },
    { key: "callbackSelf", label: "Передзвонив сам", hint: "Перший вихідний на той самий номер протягом 24 год зробив той самий менеджер." },
    { key: "callbackColleague", label: "Передзвонив колега", hint: "Перший вихідний протягом 24 год зробив інший менеджер. Для рядка «Без відповідального» будь-хто — колега." },
    { key: "noCallback", label: "Не передзвонили", hint: "Жодного вихідного на цей номер за 24 год." },
    { key: "medianMin", label: "Медіана, хв", hint: "Медіана, а не середнє: поодинокі передзвони наступного дня тягнуть середнє вдесятеро вгору." },
    { key: "clientSelf", label: "Клієнт сам", hint: "Клієнт передзвонив сам і дочекався відповіді. НЕ зараховується як наш передзвін." },
  ];
  const num = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));

  return (
    <>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          📵 Пропущені дзвінки
          <InfoHint text={
            "Дані з Ringostat. Пропущений = вхідний без розмови з відповіддю «не відповіли» або «зайнято». "
            + "Не враховуються: голосова пошта, клієнт кинув слухавку до відповіді, відповідані з нульовою розмовою. "
            + "Передзвін — перший вихідний на той самий номер протягом 24 годин."
          } />
        </h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>
          Період: {d.period.from} — {d.period.to}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          <Tile label="Пропущено" value={num(s.missed)} sub={`не враховано: ${num(s.excluded)}`}
            hint="Не враховано — голосова пошта, клієнт кинув слухавку до відповіді, відповідані з нульовою розмовою. Показані окремо, щоб їх не шукали як зниклі." />
          <Tile label="Передзвонили за 24 год" value={pct(s.callback, s.missed)} sub={`${num(s.callback)} із ${num(s.missed)}`}
            hint={`З них додзвонились: ${num(s.callbackTalked)}. Сам відповідальний — ${num(s.callbackSelf)}, колега — ${num(s.callbackColleague)}.`} />
          <Tile label="Медіана передзвону" value={s.medianMin == null ? "—" : `${s.medianMin} хв`} sub="від пропущеного до першого вихідного"
            hint="Медіана, а не середнє: розподіл хвостатий, і поодинокі «передзвонили наступного дня» тягнуть середнє вдесятеро вгору." />
          <Tile label="Клієнт передзвонив сам" value={pct(s.clientSelf, s.missed)} sub={`${num(s.clientSelf)} дзвінків`}
            hint="Клієнт сам набрав знову й дочекався відповіді. Це НЕ наш передзвін і в нього не зараховується." />
          <Tile label="Без відповідального" value={pct(s.ownerless, s.missed)} sub={`${num(s.ownerless)} дзвінків`}
            hint="Ringostat не віддав менеджера: дзвінок не дійшов до людини (черга, IVR). Такі дзвінки не приписуються нікому — ні командам, ні черговому." />
        </div>

        <h4 style={{ margin: "18px 0 8px", fontSize: 14 }}>Коли пропускаємо</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
          {BUCKETS.map((b) => (
            <Tile key={b.key} label={b.label} value={num(s.buckets[b.key])} sub={pct(s.buckets[b.key], s.missed)} hint={b.hint} />
          ))}
        </div>
      </div>

      <div className="chart-card">
        <h3 style={{ margin: "0 0 12px" }}>По менеджерах</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ ...head, textAlign: "left", cursor: "default" }}>Менеджер</th>
                {cols.map((c) => (
                  <th key={c.key} style={head} onClick={() => setSort(c.key)} title="Сортувати">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {c.label}{sort === c.key ? " ↓" : ""} <InfoHint text={c.hint} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.managerId ?? "ownerless"} style={{
                  borderBottom: "1px solid var(--border)",
                  color: r.managerId === null ? "var(--text-muted)" : "inherit",
                  fontStyle: r.managerId === null ? "italic" : "normal",
                }}>
                  <td style={{ ...cell, textAlign: "left" }}>{r.name}</td>
                  <td style={cell}>{num(r.missed)}</td>
                  <td style={cell}>{num(r.callbackSelf)}</td>
                  <td style={cell}>{num(r.callbackColleague)}</td>
                  <td style={cell}>{num(r.noCallback)}</td>
                  <td style={cell}>{num(r.medianMin)}</td>
                  <td style={cell}>{num(r.clientSelf)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td style={{ ...cell, textAlign: "left" }}>{d.total.name}</td>
                <td style={cell}>{num(d.total.missed)}</td>
                <td style={cell}>{num(d.total.callbackSelf)}</td>
                <td style={cell}>{num(d.total.callbackColleague)}</td>
                <td style={cell}>{num(d.total.noCallback)}</td>
                {/* Медіани не додаються: справжня медіана періоду стоїть у плитці вище. */}
                <td style={cell} title="Медіана періоду — у плитці «Медіана передзвону» вище">{s.medianMin == null ? "—" : s.medianMin}</td>
                <td style={cell}>{num(d.total.clientSelf)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
        {label} <InfoHint text={hint} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
