import { addDays, addMonth, ddmm, mondayOf, monthEnd, monthStart, periodOf, sundayOf, type PeriodState } from "./periodRules";

/**
 * 🎚 ШКАЛА ПЕРІОДУ ПІД НАВІГАТОРОМ (Роман 10.11.2026: «та сама шкала вибору, але по днях, тижнях — підсвічується
 * вибраний тиждень — і місяцях»). Кнопки режиму самі по собі лише міняли одиницю, а дати доводилось клацати
 * стрілками чи календарем — шкала показує сусідні одиниці того ж режиму й вибирає одну кліком.
 *
 *  • День    — дні місяця, у якому стоїть вибраний день;
 *  • Тиждень — тижні (пн–нд), що зачіпають цей місяць; вибраний підсвічено;
 *  • Місяць  — 12 місяців року.
 * Майбутнє не вибирається: даних там немає, і порожній екран читався б як «нічого не витратили».
 * У режимі «Період» шкали немає — там дати задаються календарем.
 *
 * 📐 Рівна СІТКА, а не flex-wrap (Роман 10.11: «виглядає не рівномірно»): клітинки одного режиму однакові й
 * заповнюють ширину; рік/місяць — один раз у заголовку, а не в кожній клітинці.
 */
const MON = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
const MON_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const WD = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"];

interface Cell { key: string; top: string; main: string; on: boolean; future: boolean; weekend?: boolean; patch: Partial<PeriodState> }

function cellsOf(s: PeriodState, today: string): Cell[] {
  const p = periodOf(s);
  if (s.mode === "day") {
    const out: Cell[] = [];
    for (let d = monthStart(s.focusDay); d <= monthEnd(s.focusDay); d = addDays(d, 1)) {
      const w = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
      out.push({ key: d, top: WD[w], main: String(Number(d.slice(8))), on: d === p.from, future: d > today, weekend: w >= 5,
                 patch: { focusDay: d, anchor: d } });
    }
    return out;
  }
  if (s.mode === "week") {
    const out: Cell[] = [];
    let n = 1;
    for (let m = mondayOf(monthStart(s.focusDay)); m <= monthEnd(s.focusDay); m = addDays(m, 7), n++) {
      out.push({ key: m, top: `${n}-й тиждень`, main: `${ddmm(m)} – ${ddmm(sundayOf(m))}`, on: m === p.from, future: m > today,
                 patch: { focusDay: m, anchor: m } });
    }
    return out;
  }
  if (s.mode === "month") {
    const y = s.anchor.slice(0, 4);
    return Array.from({ length: 12 }, (_, i) => {
      const m = `${y}-${String(i + 1).padStart(2, "0")}-01`;
      // focusDay теж у цей місяць — інакше перемикач на «Тиждень»/«День» стрибнув би назад до старого дня.
      const last = monthEnd(m) > today ? today : monthEnd(m);
      return { key: m, top: String(i + 1).padStart(2, "0"), main: MON[i], on: m === monthStart(s.anchor), future: m > today,
               patch: { anchor: m, focusDay: last } };
    });
  }
  return [];
}

/** Мінімальна ширина клітинки: усі одиниці стоять в ОДИН рядок (31 день — теж), на вузькому екрані — прокрутка. */
const MIN_W: Record<string, number> = { day: 34, week: 140, month: 64 };

export function PeriodStrip({ state, onPatch, today }: { state: PeriodState; onPatch: (p: Partial<PeriodState>) => void; today: string }) {
  const cells = cellsOf(state, today);
  if (cells.length === 0) return null;
  // Сусідній відрізок шкали: рік місяців або місяць днів/тижнів.
  const shift = (dir: number) => onPatch(state.mode === "month"
    ? { anchor: addMonth(state.anchor, dir * 12) }
    : { focusDay: addMonth(state.focusDay, dir), anchor: addMonth(state.focusDay, dir) });
  const title = state.mode === "month" ? `${state.anchor.slice(0, 4)} рік`
    : `${MON_FULL[Number(state.focusDay.slice(5, 7)) - 1]} ${state.focusDay.slice(0, 4)}`;
  const arrow: React.CSSProperties = {
    width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
    border: "1px solid var(--rpt-line, #e8e6e3)", background: "var(--rpt-card, #fff)", color: "var(--rpt-ink, #16181d)",
    borderRadius: 8, cursor: "pointer", fontSize: 14,
  };
  return (
    <div style={{ background: "var(--rpt-card, #fff)", border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 14,
                  padding: "14px 16px 16px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" style={arrow} onClick={() => shift(-1)} aria-label="попередній відрізок">‹</button>
          <b style={{ fontSize: 15, minWidth: 120, textAlign: "center", letterSpacing: "-.2px" }}>{title}</b>
          <button type="button" style={arrow} onClick={() => shift(1)} aria-label="наступний відрізок">›</button>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".9px", textTransform: "uppercase", color: "var(--rpt-muted, #8a8f98)" }}>
          {state.mode === "day" ? "оберіть день" : state.mode === "week" ? "оберіть тиждень" : "оберіть місяць"}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, minmax(${MIN_W[state.mode]}px, 1fr))`,
                    gap: state.mode === "day" ? 4 : 6 }}>
        {cells.map((c) => (
          <button key={c.key} type="button" disabled={c.future} aria-pressed={c.on} onClick={() => onPatch(c.patch)}
            style={{ height: state.mode === "day" ? 50 : 54, padding: "0 4px", borderRadius: state.mode === "day" ? 8 : 10, lineHeight: 1.15,
                     display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                     border: `1px solid ${c.on ? "var(--rpt-ink, #16181d)" : "var(--rpt-line, #e8e6e3)"}`,
                     background: c.on ? "var(--rpt-ink, #16181d)" : c.weekend ? "var(--rpt-soft, #f6f5f3)" : "var(--rpt-card, #fff)",
                     color: c.on ? "var(--rpt-card, #fff)" : "var(--rpt-ink, #16181d)",
                     cursor: c.future ? "default" : "pointer", opacity: c.future ? 0.35 : 1 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".6px", textTransform: "uppercase",
                           color: c.on ? "var(--rpt-card, #fff)" : "var(--rpt-muted, #8a8f98)", opacity: c.on ? 0.75 : 1 }}>{c.top}</span>
            <span style={{ fontSize: state.mode === "week" ? 14 : 16, fontWeight: 800, letterSpacing: "-.2px", whiteSpace: "nowrap" }}>{c.main}</span>
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}
