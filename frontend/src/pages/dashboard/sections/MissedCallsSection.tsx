import { useEffect, useMemo, useState } from "react";
import {
  fetchMissedCalls, fetchMissedList, fetchNoDeal, fetchNoDealList,
  type MissedCallsResp, type MissedDayBucket, type MissedManagerRow, type MissedListResp,
  type MissedNextStep, type NoDealCounts, type NoDealState, type NoDealListRow,
} from "../../../api";
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

      <MissedListBlock from={d.period.from} to={d.period.to} />
      <NoDealBlock from={d.period.from} to={d.period.to} />
    </>
  );
}

const BUCKET_LABEL: Record<MissedDayBucket, string> = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label])) as Record<MissedDayBucket, string>;

/** Текст «що сталось далі». Невдалий передзвін — ОКРЕМО від вдалого: це різна робота. */
function nextLabel(kind: MissedNextStep, min: number | null): { text: string; bad: boolean } {
  const m = min == null ? "" : ` через ${String(min)} хв`;
  switch (kind) {
    case "callback_talked": return { text: `передзвонили${m}, додзвонились`, bad: false };
    case "callback_no_answer": return { text: `передзвонили${m}, не додзвонились`, bad: false };
    case "client_self": return { text: `клієнт передзвонив сам${m}`, bad: false };
    case "nothing": return { text: "нічого за 24 год", bad: true };
  }
}

/**
 * 📋 БЛОК C — пропущені за ОДИН день.
 * Список рахується тим самим виразом, що й «пропущено» в блоці A (гейт `#452`), тож за той
 * самий день рядків тут рівно стільки, скільки в числі.
 * ⚠️ Посилання на клієнта в дашборді НЕ робимо: адреси картки клієнта в продукті немає —
 * картки відкриваються діалогами всередині екранів. Вигадувати маршрут означало б
 * посилання в нікуди.
 */
function MissedListBlock({ from, to }: { from: string; to: string }) {
  const [day, setDay] = useState(to);
  const [onlyNo, setOnlyNo] = useState(false);
  const [d, setD] = useState<MissedListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Змінився період — день за межами нового періоду повертаємо на його кінець.
  useEffect(() => { if (day < from || day > to) setDay(to); }, [from, to, day]);

  useEffect(() => {
    if (!day) return;
    setD(null); setErr(null);
    fetchMissedList({ day, ...(onlyNo ? { noCallback: "1" as const } : {}) })
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : "Не вдалося завантажити"));
  }, [day, onlyNo]);

  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        📋 Список дзвінків
        <InfoHint text="Кожен пропущений за обраний день і що сталось одразу після нього. «Що сталось далі» — НАЙРАНІША подія: якщо клієнт передзвонив сам раніше, ніж ми, рядок покаже саме це." />
      </h3>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12, fontSize: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          День
          <input id="missed-list-day" type="date" value={day} min={from} max={to} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input id="missed-list-only-no" type="checkbox" checked={onlyNo} onChange={(e) => setOnlyNo(e.target.checked)} />
          лише без нашого передзвону
        </label>
      </div>

      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !d && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {d && d.rows.length === 0 && (
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          {onlyNo ? `За ${day} немає пропущених без нашого передзвону.` : `За ${day} пропущених немає.`}
        </p>
      )}
      {d && d.rows.length > 0 && (
        <>
          {d.truncated && (
            <p style={{ margin: "0 0 8px", color: "var(--danger, #c8102e)", fontSize: 13 }}>
              Показано перші {d.rows.length.toLocaleString("uk-UA")} — список за цей день довший і обрізаний.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={head}>Час</th><th style={head}>Номер</th><th style={head}>Менеджер</th>
                  <th style={head}>Коли</th><th style={head}>Що сталось далі</th><th style={head}>Угода</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => {
                  const n = nextLabel(r.next, r.nextMin);
                  return (
                    <tr key={r.uniqueid} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={cell}>{r.at}</td>
                      <td style={cell}>{r.phone ?? "номер не визначено"}</td>
                      <td style={{ ...cell, color: r.managerId === null ? "var(--text-muted)" : "inherit", fontStyle: r.managerId === null ? "italic" : "normal" }}>{r.managerName}</td>
                      <td style={cell}>{BUCKET_LABEL[r.bucket]}</td>
                      <td style={{ ...cell, color: n.bad ? "var(--danger, #c8102e)" : "inherit" }}>{n.text}</td>
                      <td style={cell}>
                        {r.dealUrl
                          ? <a href={r.dealUrl} target="_blank" rel="noreferrer">угода в CRM</a>
                          : <span style={{ color: "var(--text-muted)" }}>немає</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Підписи трьох станів — ОДИН підпис на одне значення (правило проєкту). */
const NO_DEAL_TILES: { state: NoDealState; key: keyof NoDealCounts; label: string; hint: string }[] = [
  { state: "unknown", key: "unknown", label: "Номер не знайдено в CRM",
    hint: "Номер не збігся жодним контактом у CRM. Це НЕ «заявку не завели» — це «ми не знаємо, хто дзвонив»: можливо, новий клієнт, а можливо, номер записаний у CRM інакше." },
  { state: "has_deal", key: "hasDeal", label: "Є угода",
    hint: "Клієнт відомий, і його угода створена в межах від доби до дзвінка до 7 днів після." },
  { state: "no_deal", key: "noDeal", label: "Клієнт є, заявки за тиждень немає",
    hint: "Клієнт відомий, розмова була, але жодної угоди від доби до дзвінка до 7 днів після. Найближче до «заявку не завели»." },
];

/**
 * 🧾 БЛОК D — «дзвінок був, а угоди немає». Три числа, і кожне розкривається списком,
 * порахованим ТИМ САМИМ запитом (гейт `#452`: рядків у розкритті рівно стільки, скільки в числі).
 */
function NoDealBlock({ from, to }: { from: string; to: string }) {
  const [c, setC] = useState<NoDealCounts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<NoDealState | null>(null);
  const [list, setList] = useState<{ truncated: boolean; rows: NoDealListRow[] } | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    setC(null); setErr(null); setOpen(null); setList(null);
    fetchNoDeal({ from, to })
      .then((r) => setC(r.counts))
      .catch((e) => setErr(e instanceof Error ? e.message : "Не вдалося завантажити"));
  }, [from, to]);

  useEffect(() => {
    if (!open) return;
    setList(null); setListErr(null);
    fetchNoDealList({ from, to, state: open })
      .then((r) => setList({ truncated: r.truncated, rows: r.rows }))
      .catch((e) => setListErr(e instanceof Error ? e.message : "Не вдалося завантажити"));
  }, [open, from, to]);

  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };
  const talk = (sec: number) => `${String(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, "0")}`;

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        🧾 Дзвінок був, а угоди немає
        <InfoHint text="Вхідні дзвінки, на які відповіли, розкладені на три стани. Натисніть на число, щоб побачити самі дзвінки." />
      </h3>
      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !c && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {c && (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>
            Відповіданих вхідних за період: {c.answered.toLocaleString("uk-UA")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            {NO_DEAL_TILES.map((t) => {
              const n = c[t.key];
              const active = open === t.state;
              return (
                <button key={t.state} type="button" onClick={() => setOpen(active ? null : t.state)}
                  style={{
                    textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
                    background: active ? "var(--surface-2, rgba(0,0,0,0.04))" : "transparent",
                    border: `1px solid ${active ? "var(--text-muted)" : "var(--border)"}`, borderRadius: 10, padding: "12px 14px",
                  }}>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                    {t.label} <InfoHint text={t.hint} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{n.toLocaleString("uk-UA")}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                    {pct(n, c.answered)} · {active ? "сховати список" : "показати список"}
                  </div>
                </button>
              );
            })}
          </div>

          {open && (
            <div style={{ marginTop: 14 }}>
              {listErr && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{listErr}</p>}
              {!listErr && !list && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
              {list && list.rows.length === 0 && <p style={{ margin: 0, color: "var(--text-muted)" }}>Дзвінків у цьому стані за період немає.</p>}
              {list && list.rows.length > 0 && (
                <>
                  {list.truncated && (
                    <p style={{ margin: "0 0 8px", color: "var(--danger, #c8102e)", fontSize: 13 }}>
                      Показано перші {list.rows.length.toLocaleString("uk-UA")} — список обрізаний.
                    </p>
                  )}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                          <th style={head}>Дата й час</th><th style={head}>Номер</th><th style={head}>Менеджер</th>
                          <th style={head}>Розмова</th><th style={head}>Угода</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.rows.map((r) => (
                          <tr key={r.uniqueid} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={cell}>{r.at}</td>
                            <td style={cell}>{r.phone ?? "номер не визначено"}</td>
                            <td style={{ ...cell, color: r.managerId === null ? "var(--text-muted)" : "inherit" }}>{r.managerName}</td>
                            <td style={cell}>{talk(r.talkSec)}</td>
                            <td style={cell}>
                              {r.dealUrl
                                ? <a href={r.dealUrl} target="_blank" rel="noreferrer">угода в CRM</a>
                                : <span style={{ color: "var(--text-muted)" }}>немає</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
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
