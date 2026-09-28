import type { ClientSegment, AliasName } from "../../../api";

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

/**
 * `tip` — правило категорії з сервера (`categoryRules.segmentTips`, ТЗ 22.09, п.2.4): частота
 * разом із порогами «сплячий» і «втрачений». Пороги в підказці пише ЯДРО, а не цей файл, —
 * тож змінений поріг не залишить на екрані старе число. Локальний `m.title` — лише фолбек,
 * поки відповідь без правил (старий сервер).
 */
export function SegmentBadge({ segment, gap, tip }: { segment: ClientSegment; gap?: number | null; tip?: string }) {
  const m = MAP[segment] ?? MAP.unknown;
  const base = tip ?? m.title;
  return (
    <span title={gap != null ? `${base} · медіана ${gap} дн.` : base}
      style={{ display: "inline-block", padding: "1px 7px", borderRadius: 999, fontSize: 10,
               fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}

/**
 * ⭐ ПОЗНАЧКА «ВКЛЮЧЕНИЙ ВРУЧНУ» — з приміткою в підказці.
 *
 * 🔴 Позначка БЕЗ примітки була б гіршою за її відсутність: через місяць ніхто
 * не згадає, чому цей клієнт у базі попри правило, і почне шукати баг у
 * кваліфікації. Тому примітка їде тим самим рядком даних, що й прапорець, і
 * показується в `title` — а не «десь у картці».
 */
export function ForcedBadge({ note }: { note: string | null }) {
  return (
    <span title={note ? `Включений вручну: ${note}` : "Включений вручну (примітку не збережено)"}
      style={{ display: "inline-block", padding: "1px 7px", borderRadius: 999, fontSize: 10,
               fontWeight: 700, background: "#fffbeb", color: "#92400e",
               border: "1px solid #fde68a", cursor: "help", whiteSpace: "nowrap" }}>
      ⭐ вручну
    </span>
  );
}

/**
 * 🔗 «ОБʼЄДНАНО: …» ПІД НАЗВОЮ КЛІЄНТА (ТЗ 22.09, п.2.3). План, задача й факт уже зведені
 * в цьому рядку — рядок лише показує, ХТО в ньому. Три назви видно одразу, решта — числом,
 * повний список у підказці: рядок списку не має розростатись на пів екрана.
 */
export function MergedLine({ merged }: { merged?: AliasName[] }) {
  if (!merged || merged.length === 0) return null;
  const shown = merged.slice(0, 3);
  const rest = merged.length - shown.length;
  return (
    <div title={`Обʼєднано в цього клієнта: ${merged.map((m) => m.name).join(", ")}`}
      style={{ fontSize: 11.5, color: "#1d4ed8", marginTop: 2 }}>
      🔗 обʼєднано: {shown.map((m, i) => <span key={m.key}>{i > 0 ? " · " : ""}<b style={{ fontWeight: 600 }}>{m.name}</b></span>)}
      {rest > 0 && ` +${rest}`}
    </div>
  );
}
