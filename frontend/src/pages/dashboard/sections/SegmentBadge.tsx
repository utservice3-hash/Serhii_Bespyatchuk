import type { ClientSegment } from "../../../api";

/**
 * 🧭 БЕЙДЖ СЕГМЕНТА — один компонент на всі три екрани (планування, реактивація,
 * картка). Окремо саме тому, що інакше кожен екран намалював би свою легенду:
 * назви розійшлись би, і «ВІП» на одному екрані став би «Постійним» на іншому.
 *
 * 🔴 `unknown` НЕ ХОВАЄМО. «Недостатньо історії» — це відповідь: у клієнта менше
 * трьох оплат, тож частоту рахувати нема з чого. Порожнє місце читалось би як
 * «сегмент забули порахувати», а це різні твердження.
 */
const MAP: Record<ClientSegment, { label: string; bg: string; fg: string; title: string }> = {
  vip:      { label: "⚡ ВІП", bg: "#fef3c7", fg: "#92400e",
              title: "замовляє щотижня і частіше (медіанний інтервал ≤10 дн.)" },
  regular:  { label: "🔁 Регулярний", bg: "#dbeafe", fg: "#1d4ed8",
              title: "раз на 2-4 тижні (медіанний інтервал 11-28 дн.)" },
  episodic: { label: "🌙 Епізодичний", bg: "#f1f5f9", fg: "#475569",
              title: "раз на місяць і рідше (медіанний інтервал >28 дн.)" },
  unknown:  { label: "— без історії", bg: "#f8fafc", fg: "#94a3b8",
              title: "менше 3 оплат — частоту рахувати нема з чого, сегмент не вгадуємо" },
};

export function SegmentBadge({ segment, gap }: { segment: ClientSegment; gap?: number | null }) {
  const m = MAP[segment] ?? MAP.unknown;
  return (
    <span title={gap != null ? `${m.title} · медіана ${gap} дн.` : m.title}
      style={{ display: "inline-block", padding: "1px 7px", borderRadius: 999, fontSize: 10,
               fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}
