// Pure formatting/date helpers shared across dashboard sections.

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function formatAmount(value: number): string {
  if (value <= -1_000_000 || value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}М ₴`;
  if (value <= -1_000 || value >= 1_000) return `${(value / 1_000).toFixed(0)}тис ₴`;
  return `${value.toFixed(0)} ₴`;
}

/** Exact amount, grouped, no abbreviation — e.g. "12 345 ₴". */
export function formatAmountFull(value: number): string {
  return `${Math.round(value).toLocaleString("uk-UA")} ₴`;
}

/** The equal-length period immediately before [from, to]. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");

  // Month-to-date (period starts on the 1st): compare against the SAME day
  // span of the previous month — e.g. 1–29 червня → 1–29 травня, not a
  // length-shifted window.
  if (f.getDate() === 1) {
    const prevFrom = new Date(f.getFullYear(), f.getMonth() - 1, 1);
    const day = t.getDate();
    const lastDayPrev = new Date(t.getFullYear(), t.getMonth(), 0).getDate();
    const prevTo = new Date(t.getFullYear(), t.getMonth() - 1, Math.min(day, lastDayPrev));
    return { from: fmt(prevFrom), to: fmt(prevTo) };
  }

  // Otherwise shift back by the period length (day/week/custom ranges).
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = new Date(f);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - days + 1);
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

// Automatic rank ladder by current-month paid revenue (₴). Badges escalate as
// a manager hits each threshold; brand-new managers start as "духи".
export function getRank(revenue: number): { emoji: string; title: string } {
  if (revenue >= 300000) return { emoji: "👑", title: "Король" };
  if (revenue >= 200000) return { emoji: "🔥", title: "Профі" };
  if (revenue >= 100000) return { emoji: "⭐", title: "Боєць" };
  return { emoji: "👻", title: "Дух" };
}

export function presence(lastSeen: string | null): { online: boolean; label: string } {
  if (!lastSeen) return { online: false, label: "не заходив" };
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  if (diffMs < 2 * 60 * 1000) return { online: true, label: "в мережі" };
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return { online: false, label: `був ${mins} хв тому` };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { online: false, label: `був ${hours} год тому` };
  return { online: false, label: `був ${new Date(lastSeen).toLocaleDateString("uk-UA")}` };
}
