import { useEffect, useRef, useState } from "react";
import {
  addDays, addMonth, mondayOf, monthEnd, monthStart, navBy, periodOf,
  type PeriodMode, type PeriodState,
} from "./periodRules";

/**
 * 📅 ВИБІР ПЕРІОДУ «А» — СТРІЛКИ З НАЗВОЮ (макет фільтра, погоджено Сергієм 12.11.2026).
 *
 * Довжина періоду (День · Тиждень · Місяць · Період) + ‹ назва › + календар по кліку на
 * назву. Стан і крок — ті самі `PeriodState`/`navBy`, що в `PeriodNav`: це НОВИЙ ВИГЛЯД
 * того самого контролу, а не друга логіка періоду. Тому «Реклама», яка ще сидить на
 * `PeriodNav`, і Звіт рахують період однаково — розійтись може лише верстка.
 *
 * 🔴 МАЙБУТНЄ НЕ ОБИРАЄТЬСЯ: «›» вимкнено, коли наступний період починається після
 * сьогодні, а дні/місяці після сьогодні в календарі неактивні. Дивитись «завтра» нема
 * на що, а порожній екран читався б як провал.
 */

const MON = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const MON_G = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MON_S = ["січ", "лют", "бер", "квіт", "трав", "черв", "лип", "серп", "вер", "жовт", "лист", "груд"];
const WD_FULL = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"];
const MODE_LABEL: Record<PeriodMode, string> = { day: "День", week: "Тиждень", month: "Місяць", range: "Період" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dNum = (s: string) => Number(s.slice(8));
const mIdx = (s: string) => Number(s.slice(5, 7)) - 1;
const dow0 = (s: string) => { const w = new Date(s + "T00:00:00Z").getUTCDay(); return w === 0 ? 6 : w - 1; };

/** Назва періоду словами: «Сьогодні, 13 листопада», «Листопад 2026», «10–16 листопада». */
export function stepperLabel(s: PeriodState, today: string): string {
  const p = periodOf(s);
  if (s.mode === "day") {
    const head = p.from === today ? "Сьогодні" : p.from === addDays(today, -1) ? "Вчора" : cap(WD_FULL[dow0(p.from)]);
    return `${head}, ${dNum(p.from)} ${MON_G[mIdx(p.from)]}`;
  }
  if (s.mode === "month") return `${cap(MON[mIdx(p.from)])} ${p.from.slice(0, 4)}`;
  if (p.from.slice(0, 7) === p.to.slice(0, 7)) return `${dNum(p.from)}–${dNum(p.to)} ${MON_G[mIdx(p.from)]}`;
  return `${dNum(p.from)} ${MON_S[mIdx(p.from)]} – ${dNum(p.to)} ${MON_S[mIdx(p.to)]}`;
}

export function PeriodStepper({ state, onPatch, today }: {
  state: PeriodState;
  onPatch: (p: Partial<PeriodState>) => void;
  today: string;
}) {
  const [pop, setPop] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pop) return;
    const close = (e: MouseEvent) => { if (host.current && !host.current.contains(e.target as Node)) setPop(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [pop]);

  const p = periodOf(state);
  const next = navBy(state, 1);
  const nextFrom = next ? periodOf({ ...state, ...next }).from : null;
  const canNext = nextFrom != null && nextFrom <= today;
  const isCurrent = state.mode !== "range" && p.from <= today && today <= p.to;

  const setMode = (mo: PeriodMode) => {
    if (mo === state.mode) return;
    // «Період» стартує з «початок місяця → сьогодні», як у макеті; решта зберігає день.
    if (mo === "range") onPatch({ mode: mo, rangeFrom: monthStart(today), rangeTo: today });
    else onPatch({ mode: mo });
  };
  const step = (dir: number) => {
    const patch = navBy(state, dir);
    if (!patch) return;
    // Місяць: у поточному місяці якір — сьогодні, у минулому — останній день.
    if (state.mode === "month" && patch.anchor) {
      const end = monthEnd(patch.anchor);
      const day = end > today ? today : end;
      onPatch({ anchor: day, focusDay: day });
      return;
    }
    onPatch(patch);
  };

  return (
    <div className="rv-pgrp" ref={host}>
      <div className="rv-seg" role="group" aria-label="Довжина періоду">
        {(["day", "week", "month", "range"] as PeriodMode[]).map((mo) => (
          <button key={mo} type="button" aria-pressed={state.mode === mo} onClick={() => setMode(mo)}>{MODE_LABEL[mo]}</button>
        ))}
      </div>
      <div className="rv-stepper">
        <button type="button" className="arr" aria-label="Попередній період" onClick={() => step(-1)}>‹</button>
        <button type="button" className="rv-plabel" aria-haspopup="dialog" aria-expanded={pop} onClick={() => setPop((o) => !o)}>
          {stepperLabel(state, today)}<small>▾</small>
        </button>
        <button type="button" className="arr" aria-label="Наступний період" disabled={!canNext} onClick={() => step(1)}>›</button>
      </div>
      {!isCurrent && state.mode !== "range" && (
        <button type="button" className="rv-tonow" onClick={() => onPatch({ anchor: today, focusDay: today })}>↺ До поточного</button>
      )}
      {pop && (
        <Calendar state={state} today={today}
          onPick={(patch) => { setPop(false); onPatch(patch); }} />
      )}
    </div>
  );
}

function Calendar({ state, today, onPick }: {
  state: PeriodState; today: string; onPick: (p: Partial<PeriodState>) => void;
}) {
  const sel = periodOf(state);
  const [view, setView] = useState(monthStart(sel.from)); // перший день місяця, що показано
  const [pick, setPick] = useState<string | null>(null);  // перша дата діапазону

  if (state.mode === "month") {
    const y = Number(view.slice(0, 4));
    return (
      <div className="rv-pop" role="dialog" aria-label="Оберіть місяць">
        <div className="rv-pop-h">
          <button type="button" aria-label="Попередній рік" onClick={() => setView(`${y - 1}-01-01`)}>‹</button>{y}
          <button type="button" aria-label="Наступний рік" disabled={y >= Number(today.slice(0, 4))} onClick={() => setView(`${y + 1}-01-01`)}>›</button>
        </div>
        <div className="rv-months">
          {MON_S.map((m, i) => {
            const first = `${y}-${String(i + 1).padStart(2, "0")}-01`;
            const end = monthEnd(first);
            return (
              <button key={m} type="button" disabled={first > today}
                className={sel.from === first ? "s" : ""}
                onClick={() => { const day = end > today ? today : end; onPick({ anchor: day, focusDay: day }); }}>{cap(m)}</button>
            );
          })}
        </div>
      </div>
    );
  }

  const [a, b] = state.mode === "range" && pick ? [pick, pick] : [sel.from, sel.to];
  const start = mondayOf(view);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const choose = (d: string) => {
    if (state.mode === "range") {
      if (!pick) { setPick(d); return; }
      onPick(d < pick ? { rangeFrom: d, rangeTo: pick } : { rangeFrom: pick, rangeTo: d });
      return;
    }
    onPick({ anchor: d, focusDay: d });
  };
  return (
    <div className="rv-pop" role="dialog" aria-label="Оберіть дату">
      <div className="rv-pop-h">
        <button type="button" aria-label="Попередній місяць" onClick={() => setView(addMonth(view, -1))}>‹</button>
        {cap(MON[mIdx(view)])} {view.slice(0, 4)}
        <button type="button" aria-label="Наступний місяць" disabled={addMonth(view, 1) > today} onClick={() => setView(addMonth(view, 1))}>›</button>
      </div>
      <div className="rv-cal">
        {["пн", "вт", "ср", "чт", "пт", "сб", "нд"].map((x) => <span key={x} className="wd">{x}</span>)}
        {cells.map((d) => (
          <button key={d} type="button" disabled={d > today} onClick={() => choose(d)}
            className={[d === a || d === b ? "s" : d > a && d < b ? "in" : "", d === today ? "td" : "", d.slice(0, 7) !== view.slice(0, 7) ? "out" : ""].join(" ")}>
            {dNum(d)}
          </button>
        ))}
      </div>
      {state.mode === "range" && <div className="rv-pop-note">{pick ? "Тепер оберіть кінець періоду" : "Оберіть початок періоду"}</div>}
    </div>
  );
}
