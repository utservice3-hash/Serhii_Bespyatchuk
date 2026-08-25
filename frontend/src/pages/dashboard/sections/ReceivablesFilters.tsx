import type { ReceivableAging, ReceivableCarrierPaid, ReceivableEntity } from "../../../api";
import {
  AGING_LABEL, AGING_ORDER, CARRIER_LABEL, ENTITY_LABEL, EMPTY_FILTERS,
  hasActiveFilters, type Filters, type Tab,
} from "../receivablesView";

/**
 * 🔎 ВКЛАДКИ Й ФІЛЬТРИ.
 *
 * 🔴 ФІЛЬТРА «джерело = 1С» ТУТ НЕМАЄ СВІДОМО (рішення власника 24.08.2026):
 * «виставлено через 1С» — це ЯРЛИК на рядку, а не окремий зріз екрана. Окремий
 * зріз перетворив би нормальний спосіб виставляти рахунки на «щось особливе,
 * що треба вибрати», хоча це просто друга легальна дорога рахунку.
 *
 * 🔴 ФІЛЬТРИ НЕ МІНЯЮТЬ ЖОДНОГО ЧИСЛА В ПЛИТКАХ. Плитки — це стан УСІЄЇ
 * дебіторки у скоупі; якби вони їздили за фільтром, «загальний борг» означав би
 * різне залежно від того, що людина щойно натиснула. Під таблицею натомість
 * стоїть чесний підсумок ВИДИМИХ рядків.
 */

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "all", label: "Усі", hint: "Усі боржники у скоупі" },
  { key: "overdue", label: "Прострочені", hint: "Днів без оплати більше за узгоджений ліміт" },
  { key: "aged", label: "Старші за 90 днів", hint: "Має хоча б один рахунок віком понад 90 днів" },
];

const sel: React.CSSProperties = { font: "inherit", fontSize: "var(--fs-13)", padding: "4px 8px", borderRadius: 8 };

export function ReceivablesFilters({ filters, setFilters, shown, totalRows }: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  shown: number;
  totalRows: number;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters({ ...filters, [k]: v });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "0 0 12px" }}>
      <div style={{ display: "flex", gap: 4, background: "var(--bg-subtle, rgba(127,127,127,0.08))", padding: 3, borderRadius: 10 }}>
        {TABS.map((tb) => (
          <button key={tb.key} onClick={() => set("tab", tb.key)} title={tb.hint}
            style={{
              font: "inherit", fontSize: "var(--fs-13)", fontWeight: filters.tab === tb.key ? 700 : 500,
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: filters.tab === tb.key ? "var(--card-bg)" : "transparent",
              color: filters.tab === tb.key ? "var(--text)" : "var(--text-muted)",
              boxShadow: filters.tab === tb.key ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
            }}>
            {tb.label}
          </button>
        ))}
      </div>

      <select style={sel} value={filters.entity} onChange={(e) => set("entity", e.target.value as ReceivableEntity | "")}
        title="Наша юрособа, від якої виставлено рахунок (з «форми оплати» Kommo)">
        <option value="">Будь-яка юрособа</option>
        {(Object.keys(ENTITY_LABEL) as ReceivableEntity[]).map((k) => (
          <option key={k} value={k}>{ENTITY_LABEL[k]}</option>
        ))}
      </select>

      <select style={sel} value={filters.carrier} onChange={(e) => set("carrier", e.target.value as Filters["carrier"])}
        title="Стан оплати перевізника по угоді рахунку">
        <option value="">Перевізник: будь-як</option>
        {(Object.keys(CARRIER_LABEL) as ReceivableCarrierPaid[]).map((k) => (
          <option key={k} value={k}>{CARRIER_LABEL[k]}</option>
        ))}
        {/* 🔧 Підмножина «н/д», з якою МОЖНА щось зробити: битий лінк і воронка
            поза мапою. 1С-рахунки сюди не входять — там угоди немає в принципі. */}
        <option value="na_fixable">н/д, що лагодиться</option>
      </select>

      <select style={sel} value={filters.aging} onChange={(e) => set("aging", e.target.value as ReceivableAging | "")}
        title="Вік рахунку від дати виставлення">
        <option value="">Вік: будь-який</option>
        {AGING_ORDER.map((k) => <option key={k} value={k}>{AGING_LABEL[k]}</option>)}
      </select>

      {hasActiveFilters(filters) && (
        <>
          <button onClick={() => setFilters(EMPTY_FILTERS)}
            style={{ font: "inherit", fontSize: "var(--fs-13)", padding: "4px 10px", borderRadius: 8, cursor: "pointer",
                     border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
            ✕ скинути
          </button>
          {/* Скільки сховали — числом. «Показано 12» без «із 72» читається як
              «боржників дванадцять», тобто фільтр мовчки бреше про масштаб. */}
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
            показано <b style={{ color: "var(--text)" }}>{shown}</b> із {totalRows}
          </span>
        </>
      )}
    </div>
  );
}
