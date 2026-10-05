/**
 * ⏱ ЧЕРЕЗ СКІЛЬКИ ХВИЛИН ПІСЛЯ ЗАЯВКИ МИ ПЕРЕДЗВОНИЛИ (рішення власника 05.10.2026, «як пропонуєш»): від створення
 * угоди в Kommo до ПЕРШОГО нашого вихідного дзвінка на номер клієнта — будь-якого менеджера, навіть без відповіді,
 * у календарних хвилинах. Не до самої розмови: інакше третя спроба додзвонитись читалась би як повільна реакція.
 * Поруч — позначка «заявка поза робочим часом», щоб 3 525 хв за суботу не читались як лінь.
 * `WORK_HOURS` — ПРИПУЩЕННЯ (пн–пт 9:00–18:00 за Києвом), вписане в глосарій як відкрите до підтвердження.
 */
export const WORK_HOURS = Object.freeze({ from: 9, to: 18 });

export function reactionMinutes(dealCreatedAt: string, firstOutboundAt: string | null): number | null {
  if (!firstOutboundAt) return null;
  const m = Math.round((new Date(firstOutboundAt).getTime() - new Date(dealCreatedAt).getTime()) / 60_000);
  return m < 0 ? 0 : m;
}

/** Заявка надійшла у вихідний або поза робочими годинами — за київським часом. */
export function offHours(dealCreatedAt: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", weekday: "short", hour: "2-digit", hour12: false })
    .formatToParts(new Date(dealCreatedAt));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return wd === "Sat" || wd === "Sun" || h < WORK_HOURS.from || h >= WORK_HOURS.to;
}

/** Медіана (для рядка менеджера); `null` — немає жодного значення. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
