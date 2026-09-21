import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  fetchReportPlan, fetchManualSlides,
  type NominationWeek, type NominationKey, type ReportPlan, type ManualSlide,
} from "../../../api";
import { Logo } from "../../../components/Logo";
import { formatAmountFull } from "../format";
import truck from "../../../assets/presentation-truck.jpg";
import "./presentation.css";

/**
 * 🎞 ПРЕЗЕНТАЦІЯ ЩОТИЖНЕВОЇ ЗУСТРІЧІ (прохід 2, 21.09.2026). Замінює презентацію, яку Даша
 * щовівторка збирала руками. Оформлення — з її шаблону; показ — у браузері на весь екран, ← →.
 *
 * ЗВІДКИ ЧИСЛА — лише з тих самих ендпоінтів, що й екрани, без власної арифметики по грошах:
 *  · рейтинг — `/nominations/week` (зафіксований знімок; до фіксації — чернетка з позначкою);
 *  · «План виконали» — колонка «Виконано» (`pct`) Звіту за період з 1-го числа до сьогодні
 *    (рішення 21.09.2026: від плану на сьогодні, як на Звіті);
 *  · «Підсумки» — верх Звіту за весь поточний місяць (`glance`: факт, план, очікуємо за датою);
 *  · ручні слайди — `/nominations/manual-slides` (новачки, дні народження, новини).
 */

const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const monthEnd = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const short = (n: string) => n.split(/\s+/).slice(0, 2).join(" ");
const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
const teamShort = (t: string) => t.split(" - ").slice(1).join(" - ") || t;
function fmt(unit: "uah" | "count" | "pct", v: number | null): string {
  if (v == null) return "—";
  if (unit === "uah") return formatAmountFull(v);
  if (unit === "pct") return `${Math.round(v)}%`;
  return String(v);
}
const SECTIONS = ["Рейтинг менеджерів", "Виконання плану", "Підсумки"] as const;

/** Хто виконав план з 1-го числа — за колонкою «Виконано» Звіту, по командах. */
export function planDoneTeams(r: ReportPlan | null): { team: string; people: { name: string; pct: number }[] }[] {
  if (!r) return [];
  const by = new Map<string, { name: string; pct: number }[]>();
  for (const m of r.managers) {
    if (!(m.plan > 0) || m.pct == null || m.pct < 100) continue;
    const t = m.teamName ?? "Без команди";
    by.set(t, [...(by.get(t) ?? []), { name: m.name, pct: m.pct }]);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0], "uk"))
    .map(([team, people]) => ({ team, people: people.sort((a, b) => b.pct - a.pct) }));
}

/** Підпис розділу в бічній панелі для ручного слайда — як у Дашиній презентації. */
export function manualSection(s: ManualSlide): string {
  const f = s.fields ?? {};
  switch (s.kind) {
    case "newcomer": return "Вітаємо в команді!";
    case "birthday": return "День народження";
    case "news": return "Новини";
    case "contest": return "Конкурс тижня";
    case "webinar": return f.title || "Анонс";
    default: return f.title || s.title;
  }
}
const lines = (v?: string) => (v ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const Photo = ({ who }: { who?: string }) => (
  <div className="ps-photo"><div className="ps-ava big">{initials(who || "?")}</div></div>
);

/**
 * Верстка ручного слайда за його шаблоном. Компонування кожної гілки — з відповідного слайда Даші
 * (`UTS_weekly_meeting_template.pptx`). Набір гілок звіряє #611 з реєстром шаблонів сервера.
 */
function templateSlide(s: ManualSlide): ReactElement {
  const f = s.fields ?? {};
  switch (s.kind) {
    case "newcomer":
      return (<>
        <div className="ps-h ps-h-bar">{[f.headline, f.person].filter(Boolean).join(" - ")}</div>
        <div className="ps-tcard">
          <Photo who={f.person} />
          <div className="ps-tbody">
            <div className="ps-tname2">{f.person}</div>
            {f.achievement ? <div className="ps-tach">{f.achievement}</div> : null}
            {f.wish ? <div className="ps-twish">{f.wish}</div> : null}
          </div>
          {f.date ? <div className="ps-tdate">{f.date}</div> : null}
        </div>
      </>);
    case "birthday":
      return (<>
        <div className="ps-h">З Днем народження!</div>
        <div className="ps-tcard">
          <Photo who={f.person} />
          <div className="ps-tbody">
            <div className="ps-tcong">ВІТАЄМО</div>
            <div className="ps-tname2">{f.person}</div>
            <div className="ps-tbday">з Днем народження!</div>
            {f.wish ? <div className="ps-twish small">{f.wish}</div> : null}
            {f.date ? <div className="ps-tdate inline">{f.date}</div> : null}
          </div>
        </div>
      </>);
    case "news":
      return (<>
        <div className="ps-h ps-h-big">{f.title || "Новини!"}</div>
        <div className="ps-tcard col">
          <div className="ps-news">{f.text}</div>
          {f.wish ? <div className="ps-newswish">{f.wish}</div> : null}
        </div>
      </>);
    case "contest":
      return (<>
        <div className="ps-kick">КОНКУРС ТИЖНЯ</div>
        <div className="ps-h tight">{f.title || "Три місця на пʼєдесталі"}</div>
        {f.description ? <div className="ps-desc">{f.description}</div> : null}
        <div className="ps-podium">
          <div className="ps-place"><div className="pl">2 МІСЦЕ</div><div className="pv">{f.prize2}</div></div>
          <div className="ps-place first"><div className="pl">1 МІСЦЕ</div><div className="pv">{f.prize1}</div></div>
          <div className="ps-place"><div className="pl">3 МІСЦЕ</div><div className="pv">{f.prize3}</div></div>
        </div>
        {lines(f.rules).length ? <div className="ps-list"><div className="lt">ПРАВИЛА ЧЕСНОЇ ГРИ</div>
          {lines(f.rules).map((r) => <div className="li" key={r}><i>→</i>{r}</div>)}</div> : null}
        {f.total ? <div className="ps-stake"><span>НА КОНУ ЦЬОГО ТИЖНЯ</span><b>{f.total}</b></div> : null}
      </>);
    case "webinar":
      return (<>
        <div className="ps-kick">АНОНС</div>
        <div className="ps-h tight">{f.title || "Навчальний вебінар"}</div>
        {f.description ? <div className="ps-desc">{f.description}</div> : null}
        <div className="ps-banner"><div className="when">{f.when}</div>
          <div className="topic"><div className="tl">ТЕМА</div><div className="tv">{f.topic}</div></div></div>
        <div className="ps-cols">
          {[["СПІКЕР", f.speaker], ["ФОРМАТ", f.format], ["ДЛЯ КОГО", f.audience]].map(([l, v]) => (
            <div className="c" key={l}><i /><div className="cl">{l}</div><div className="cv">{v || "—"}</div></div>
          ))}
        </div>
        {lines(f.points).length ? <div className="ps-list"><div className="lt">ЩО РОЗГЛЯНЕМО</div>
          {lines(f.points).map((r) => <div className="li" key={r}><i>→</i>{r}</div>)}</div> : null}
      </>);
    case "custom":
    default:
      return (<>
        <div className="ps-h">{f.title || s.title}</div>
        <div className="ps-manual">
          {f.person ? <div className="ps-ava big">{initials(f.person)}</div> : null}
          <div>{f.person ? <div className="ps-mname">{f.person}</div> : null}{f.body ? <div className="ps-mtext">{f.body}</div> : null}</div>
        </div>
      </>);
  }
}

export function NominationsPresentation({ week, onClose }: { week: NominationWeek; onClose: () => void }) {
  const [toDate, setToDate] = useState<ReportPlan | null>(null);
  const [month, setMonth] = useState<ReportPlan | null>(null);
  const [manual, setManual] = useState<ManualSlide[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [scale, setScale] = useState(1);
  const overlay = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const today = kyivToday();
  const mStart = `${today.slice(0, 7)}-01`;

  useEffect(() => {
    Promise.all([
      fetchReportPlan({ from: mStart, to: today }),
      fetchReportPlan({ from: mStart, to: monthEnd(today) }),
      fetchManualSlides(week.weekFrom),
    ]).then(([a, b, c]) => { setToDate(a); setMonth(b); setManual(c.slides); })
      .catch(() => setErr("Не вдалося завантажити дані для слайдів — спробуйте ще раз"));
  }, [week.weekFrom, mStart, today]);

  const draft = week.state !== "frozen";
  const meeting = week.freezeDueAt.slice(0, 10);
  const name = useCallback((id: number) => week.names[String(id)] ?? `Менеджер #${id}`, [week.names]);

  const slides = useMemo(() => {
    const out: { key: string; node: ReactElement }[] = [];
    const mark = draft ? <div className="ps-watermark">ЧЕРНЕТКА · тиждень ще не зафіксовано</div> : null;
    // Розділи бічної панелі — як у Даші: спершу розділи наявних ручних слайдів, потім сталі.
    const nav = [...new Set(manual.map(manualSection)), ...SECTIONS];
    const frame = (active: string, body: ReactElement) => (
      <div className="ps-slide">
        <aside className="ps-side">
          <div className="ps-logo"><Logo variant="red" size={44} /></div>
          {nav.map((s) => <div key={s} className={`ps-nav${s === active ? " on" : ""}`}>{s}</div>)}
          <div className="ps-date">{dmy(meeting)}</div>
        </aside>
        <div className="ps-main">{body}</div>
        {mark}
      </div>
    );

    out.push({ key: "title", node: (
      <div className="ps-title">
        <img className="ps-truck" src={truck} alt="" />
        <div className="ps-tlogo"><Logo variant="red" size={70} /></div>
        <h1>ЩОТИЖНЕВА<br />ЗУСТРІЧ</h1>
        <div className="ps-tpill">Для співробітників UTS</div>
        <div className="ps-tsub">{dmy(meeting)} · підсумки тижня {dm(week.weekFrom)}–{dm(week.weekTo)}</div>
        <div className="ps-tfoot">UTS — ТРАНСПОРТНА КОМПАНІЯ</div>
        {mark}
      </div>
    ) });

    for (const s of manual) out.push({ key: `m${s.id}`, node: frame(manualSection(s), templateSlide(s)) });

    const unit = (k: NominationKey) => week.defs.find((d) => d.key === k)?.unit ?? "count";
    const card = (dept: "rpk" | "rnk", title: string) => (
      <div className="ps-card">
        <div className="ps-head">{title}</div>
        {week.defs.map((def) => {
          const k = def.key;
          const w = week.depts.find((x) => x.dept === dept && x.nomination === k);
          const teams = w ? w.teams.map((t) => week.teams.find((x) => x.teamId === t)).filter((t): t is NonNullable<typeof t> => !!t) : [];
          const manualWin = teams.some((t) => t.cells.some((c) => c.nomination === k && c.final.status === "overridden"));
          return (
            <div key={k}>
              <div className="ps-lab">{def.label.toUpperCase()}</div>
              <div className="ps-val">
                {w && w.state === "ok"
                  ? <>{w.winners.map((id) => short(name(id))).join(", ")} — <b>{fmt(unit(k), w.value)}</b>
                      {k === "marginPct" && (w.value ?? 0) > week.marginFlagPct ? <span className="ps-flag">⚑ понад {week.marginFlagPct}% від виплати водію</span> : null}
                      {manualWin ? <span className="ps-manual-mark">✎ за даними тімліда</span> : null}
                      <div className="ps-tm">{teams.map((t) => teamShort(t.teamName)).join(", ")}</div></>
                  : <span className="ps-muted">ніхто не набрав</span>}
              </div>
            </div>
          );
        })}
      </div>
    );
    out.push({ key: "rating", node: frame(SECTIONS[0], (
      <>
        <div className="ps-kick">ТИЖДЕНЬ {dm(week.weekFrom)}–{dmy(week.weekTo)}</div>
        <div className="ps-h">Рейтинг менеджерів</div>
        <div className="ps-two">{card("rpk", "ВРПК — відділ роботи з постійними клієнтами")}{card("rnk", "ВРНК — відділ роботи з новими клієнтами")}</div>
      </>
    )) });

    const monthWord = MONTHS_GEN[Number(today.slice(5, 7)) - 1];
    const done = planDoneTeams(toDate);
    if (toDate && done.length === 0) out.push({ key: "plan-none", node: frame(SECTIONS[1], (
      <><div className="ps-kick">ВИКОНАННЯ ПЛАНУ · З 1 {monthWord.toUpperCase()} · СТАНОМ НА {dm(today)}</div>
        <div className="ps-h">План виконали</div>
        <div className="ps-manual"><div className="ps-mtext">Станом на {dm(today)} план від 1 {monthWord} ще ніхто не виконав на 100%.</div></div></>
    )) });
    for (const g of done) out.push({ key: `plan-${g.team}`, node: frame(SECTIONS[1], (
      <>
        <div className="ps-kick">ВИКОНАННЯ ПЛАНУ · З 1 {monthWord.toUpperCase()} · СТАНОМ НА {dm(today)}</div>
        <div className="ps-h">План виконали</div>
        <div className="ps-plan">
          <div className="ps-red">
            <div className="ps-tlab">Команда</div>
            <div className="ps-tname">{teamShort(g.team)}</div>
            <div className="ps-pink">План виконали</div>
            <div className="ps-cong">Вітаємо з успішним виконанням плану! Це чудовий результат, який є вашою спільною заслугою.</div>
          </div>
          <div className={`ps-grid${g.people.length > 6 ? " many" : ""}`}>
            {g.people.map((p) => (
              <div className="ps-pp" key={p.name}><div className="ps-ava">{initials(p.name)}</div><div className="ps-pn">{short(p.name)}</div><div className="ps-pc">{p.pct}%</div></div>
            ))}
          </div>
        </div>
      </>
    )) });

    if (month) {
      const g = month.glance;
      out.push({ key: "summary", node: frame(SECTIONS[2], (
        <>
          <div className="ps-kick">НА ЗАВЕРШЕННЯ</div>
          <div className="ps-h">Дякуємо за увагу!</div>
          <div className="ps-subt">Найкраща команда — далі тільки більше!</div>
          <div className="ps-sum">
            <div className="ps-slab">ПІДСУМКИ · СТАНОМ НА {dm(today)}</div>
            <div className="ps-row"><i /><div><div className="ps-rl">КОМАНДА ЗА МІСЯЦЬ</div>
              <div className="ps-rv">{Math.round(g.fact).toLocaleString("uk-UA")} / {formatAmountFull(g.plan)}{g.plan > 0 ? ` · ${Math.round((g.fact / g.plan) * 100)}%` : ""}</div></div></div>
            <div className="ps-row"><i /><div><div className="ps-rl">ОЧІКУЄМО ЗА ПЛАН. ДАТОЮ</div>
              <div className="ps-rv">{formatAmountFull(g.expectThisMonth)} цей міс</div></div></div>
          </div>
          <div className="ps-bye">До зустрічі!</div>
        </>
      )) });
    }
    return out;
  }, [week, manual, toDate, month, draft, meeting, name, today]);

  const n = slides.length;
  const go = (k: number) => setI(Math.max(0, Math.min(n - 1, k)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); setI((c) => Math.min(n - 1, c + 1)); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); setI((c) => Math.max(0, c - 1)); }
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(n - 1);
      else if (e.key === "Escape" && !document.fullscreenElement) onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [n, onClose]);

  useLayoutEffect(() => {
    const fit = () => {
      const v = viewport.current;
      if (v) setScale(Math.min(v.clientWidth / 1280, v.clientHeight / 720));
    };
    fit();
    addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fit);
    return () => { removeEventListener("resize", fit); document.removeEventListener("fullscreenchange", fit); };
  }, []);

  const full = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void overlay.current?.requestFullscreen?.(); };
  const cur = slides[Math.min(i, n - 1)];

  return (
    <div className="ps-overlay" ref={overlay} role="dialog" aria-label="Презентація щотижневої зустрічі">
      <div className="ps-bar">
        <b>Презентація · тиждень {dm(week.weekFrom)}–{dm(week.weekTo)}</b>
        {draft ? <span className="ps-draft">Чернетка: тиждень ще не зафіксовано</span> : null}
        {err ? <span style={{ color: "#fca5a5" }}>{err}</span> : null}
        <span className="sp" />
        <button onClick={() => go(i - 1)} aria-label="попередній слайд" disabled={i === 0}>←</button>
        <span>{Math.min(i + 1, n)} / {n}</span>
        <button onClick={() => go(i + 1)} aria-label="наступний слайд" disabled={i >= n - 1}>→</button>
        <button onClick={full}>На весь екран</button>
        <button onClick={onClose}>Закрити</button>
      </div>
      <div className="ps-viewport" ref={viewport} onClick={(e) => { if (e.target === viewport.current) go(i + 1); }}>
        <div className="ps-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>{cur?.node}</div>
      </div>
    </div>
  );
}
