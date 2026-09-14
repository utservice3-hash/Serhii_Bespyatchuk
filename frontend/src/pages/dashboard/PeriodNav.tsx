import { DatePicker } from "../../components/DatePicker";
import { navBy, type PeriodMode, type PeriodState } from "./periodRules";

/**
 * 📅 НАВІГАТОР ПЕРІОДУ — ОДИН КОНТРОЛ НА ВСІ ЕКРАНИ, ЩО ВИБИРАЮТЬ ПЕРІОД.
 *
 * 🔴 ЧОМУ ВІН ЗʼЯВИВСЯ (09.09.2026). Розмітка жила всередині `ReportPlanSection` і була
 * невідтворювана деінде. Коли «Реклама» попросила «такий самий вибір періоду, як у
 * Звіті», я двічі спробував обійтись наявним: спершу поставив `QuickPeriods` із власним
 * підписом «ПЕРІОД» (третій вигляд одного контрола в продукті), потім переклав його на
 * спільні класи (другий вигляд). Обидва рази це був НЕ той контрол. Копіювати розмітку
 * втретє означало б завести два навігатори, які розійдуться на першій же правці — тому
 * розмітка переїхала СЮДИ, а Звіт тепер малює її звідси.
 *
 * ⚠️ ВИГЛЯД ПЕРЕЇХАВ БАЙТ-У-БАЙТ. Жодного «заодно причешу»: інакше приймання Звіту
 * стало б неможливим — незрозуміло, чи змінилось щось через переїзд, чи через
 * причісування. Звіт після цього мусить виглядати ТОЧНО як до.
 *
 * 🧩 `children` — місце для контролів, які має лише один екран (у Звіті це вибір
 * команди). Вони йдуть у ТОМУ Ж ряду: окремий ряд під навігатором читався б як
 * другий фільтр, а не як частина того самого.
 */

/** Стиль кнопок навігації. Експортується: у Звіті ним же оформлений вибір команди. */
export const navBtn: React.CSSProperties = {
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
  borderRadius: 8, padding: "7px 12px", fontSize: 13, cursor: "pointer",
};

const MUTED = "var(--text-muted)";
const MODE_LABEL: Record<PeriodMode, string> = { day: "День", week: "Тиждень", month: "Місяць", range: "Період" };

export function PeriodNav({ state, onPatch, today, children }: {
  state: PeriodState;
  onPatch: (p: Partial<PeriodState>) => void;
  today: string;
  children?: React.ReactNode;
}) {
  const nav = (dir: number) => { const p = navBy(state, dir); if (p) onPatch(p); };

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 11 }}>
        {(["day", "week", "month", "range"] as PeriodMode[]).map((mo) => (
          <button key={mo} onClick={() => onPatch({ mode: mo })} style={{
            padding: "7px 15px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600,
            background: state.mode === mo ? "var(--card-bg)" : "transparent", color: state.mode === mo ? "var(--text)" : MUTED,
            boxShadow: state.mode === mo ? "0 1px 3px rgba(20,30,50,.1)" : "none",
          }}>{MODE_LABEL[mo]}</button>
        ))}
      </div>
      <button onClick={() => nav(-1)} style={navBtn} title="попередній період тієї ж довжини">←</button>
      <button onClick={() => onPatch({ anchor: today, focusDay: today })} style={navBtn}>Сьогодні</button>
      {/* #15 — швидко на поточний тиждень */}
      <button onClick={() => onPatch({ mode: "week", anchor: today, focusDay: today })} style={navBtn}>Поточний тиждень</button>
      <button onClick={() => nav(1)} style={navBtn} title="наступний період тієї ж довжини">→</button>
      {state.mode === "range" ? (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, color: MUTED }}>
          <DatePicker value={state.rangeFrom} onChange={(v) => v && onPatch({ rangeFrom: v })} mode="day" minWidth={130} />–
          <DatePicker value={state.rangeTo} onChange={(v) => v && onPatch({ rangeTo: v })} mode="day" minWidth={130} />
        </span>
      ) : (
        <DatePicker value={state.anchor} onChange={(v) => v && onPatch({ anchor: v, focusDay: v })} mode="day" minWidth={140} />
      )}
      {children}
    </div>
  );
}
