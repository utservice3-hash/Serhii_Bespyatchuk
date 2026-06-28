import { useState } from "react";

interface DateRange {
  from: string;
  to: string;
}

interface DateRangeFilterProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function getDateRange(preset: string): DateRange {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const from = new Date(today);
  const to = new Date(today);

  switch (preset) {
    case "today":
      break;
    case "yesterday":
      from.setDate(from.getDate() - 1);
      to.setDate(to.getDate() - 1);
      break;
    case "last7":
      from.setDate(from.getDate() - 6);
      break;
    case "last30":
      from.setDate(from.getDate() - 29);
      break;
    case "thisWeek": {
      // Monday-start week (Ukrainian convention; getDay(): Sun=0..Sat=6).
      const offset = (from.getDay() + 6) % 7;
      from.setDate(from.getDate() - offset);
      break;
    }
    case "lastWeek": {
      const offset = (from.getDay() + 6) % 7;
      from.setDate(from.getDate() - offset - 7);
      to.setDate(to.getDate() - offset - 1);
      break;
    }
    case "thisMonth":
      from.setDate(1);
      break;
    case "lastMonth":
      from.setMonth(from.getMonth() - 1);
      from.setDate(1);
      to.setDate(0);
      break;
    case "quarter":
      from.setDate(from.getDate() - 89);
      break;
    case "year":
      from.setFullYear(from.getFullYear() - 1);
      break;
    case "alltime":
      return { from: "", to: "" };
  }

  // Format in local time (avoid toISOString's UTC shift moving e.g. June 1 → May 31).
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(from), to: fmt(to) };
}

/** Compact, always-visible quick period buttons (not hidden in a dropdown). */
export const QUICK_PERIODS = [
  { id: "today", label: "Сьогодні" },
  { id: "yesterday", label: "Вчора" },
  { id: "thisWeek", label: "Поточний тиждень" },
  { id: "lastWeek", label: "Минулий тиждень" },
  { id: "thisMonth", label: "Поточний місяць" },
  { id: "lastMonth", label: "Минулий місяць" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Рік" },
  { id: "alltime", label: "Весь час" },
];

export function QuickPeriods({
  active,
  onSelect,
}: {
  active: string | null;
  onSelect: (id: string, range: DateRange) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
      {QUICK_PERIODS.map((p) => {
        const isActive = active === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id, getDateRange(p.id))}
            style={{
              padding: "5px 12px",
              borderRadius: 16,
              border: `1px solid ${isActive ? "#c5141c" : "#d0d5dd"}`,
              background: isActive ? "#c5141c" : "#fff",
              color: isActive ? "#fff" : "#344054",
              cursor: "pointer",
              fontSize: 13,
              whiteSpace: "nowrap",
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

const PRESETS = [
  { id: "today", label: "За сьогодня" },
  { id: "yesterday", label: "За вчера" },
  { id: "last7", label: "За останні 7 днів" },
  { id: "last30", label: "За останні 30 днів" },
  { id: "thisWeek", label: "За цю неділю" },
  { id: "lastWeek", label: "За минулу неділю" },
  { id: "thisMonth", label: "За цей місяць" },
  { id: "lastMonth", label: "За попередній місяць" },
  { id: "quarter", label: "За квартал" },
  { id: "year", label: "За цей рік" },
];

export function DateRangeFilter({ value, onChange }: DateRangeFilterProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  const handlePreset = (presetId: string) => {
    onChange(getDateRange(presetId));
    setShowDropdown(false);
  };

  const displayLabel = `${value.from} — ${value.to}`;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        style={{
          padding: "8px 12px",
          backgroundColor: "#f0f0f0",
          border: "1px solid #ccc",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "14px",
          fontFamily: "inherit",
        }}
      >
        📅 {displayLabel}
      </button>

      {showDropdown && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "4px",
            backgroundColor: "white",
            border: "1px solid #ccc",
            borderRadius: "4px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            zIndex: 1000,
            minWidth: "200px",
          }}
        >
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handlePreset(preset.id)}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 12px",
                textAlign: "left",
                border: "none",
                backgroundColor: "transparent",
                cursor: "pointer",
                fontSize: "14px",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f5f5f5")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              {preset.label}
            </button>
          ))}

          <div style={{ borderTop: "1px solid #eee", padding: "8px 12px" }}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "4px" }}>
              <input
                type="date"
                value={value.from}
                onChange={(e) => onChange({ ...value, from: e.target.value })}
                style={{ flex: 1, padding: "4px", fontSize: "12px" }}
              />
              <input
                type="date"
                value={value.to}
                onChange={(e) => onChange({ ...value, to: e.target.value })}
                style={{ flex: 1, padding: "4px", fontSize: "12px" }}
              />
            </div>
            <button
              onClick={() => setShowDropdown(false)}
              style={{
                width: "100%",
                padding: "6px",
                backgroundColor: "#007bff",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "12px",
              }}
            >
              Застосувати
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
