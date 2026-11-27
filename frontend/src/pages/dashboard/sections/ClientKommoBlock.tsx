import type { ClientCard } from "../../../api";

/**
 * 🔗 «ВІДКРИТИ В KOMMO» — ПЕРШИЙ РЯДОК КАРТКИ КЛІЄНТА (Роман 27.11.2026: «хочеться щоб можна було перейти на карточку
 * клієнта в коммо через дашборд, додай якось гарно»).
 *
 * Клієнт дашборда — це часто кілька компаній Kommo (дублі CRM, обʼєднані тут), тому кнопка не одна: кожна компанія —
 * окрема «пігулка» з назвою й кількістю угод, свіжа перша. Компаній немає — ведемо на контакт останньої угоди, немає
 * й контакту — на саму угоду. Що саме показати, вирішує сервер (`core/clientKommoLinks.ts`, гейт `#11244`); тут лише вигляд.
 *
 * ⚠️ Про «компанію не прикріплено» тут НІЧОГО не пишемо: звʼязки угод із компаніями в базі неповні за горизонтом
 * бекфілу, тож відсутність компанії в нас — не факт про CRM.
 */
type Link = NonNullable<ClientCard["kommo"]>["links"][number];

const KIND_LABEL: Record<Link["kind"], string> = { company: "компанія", contact: "контакт клієнта", deal: "остання угода" };
const dealsWord = (n: number): string => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "угода" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "угоди" : "угод";
};

export function ClientKommoBlock({ card }: { card: ClientCard }) {
  const k = card.kommo;
  if (!k || k.links.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#6b7280", marginRight: 2 }}>Kommo</span>
      {k.links.map((l) => {
        const label = l.kind === "company" ? (l.name ?? "компанія без назви") : KIND_LABEL[l.kind];
        const title = l.kind === "company"
          ? `Відкрити картку компанії в Kommo${l.deals != null ? ` · ${String(l.deals)} ${dealsWord(l.deals)} цього клієнта` : ""}`
          : `Відкрити в Kommo: ${KIND_LABEL[l.kind]}`;
        return (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={title}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 320, fontSize: 12, fontWeight: 600, lineHeight: 1.2,
              padding: "4px 10px", borderRadius: 999, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8", textDecoration: "none" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            {l.kind === "company" && l.deals != null && (
              <span style={{ fontWeight: 500, color: "#60a5fa", whiteSpace: "nowrap" }}>{l.deals} {dealsWord(l.deals)}</span>
            )}
            <span aria-hidden style={{ fontSize: 11 }}>↗</span>
          </a>
        );
      })}
      {k.more > 0 && <span style={{ fontSize: 11, color: "#6b7280" }}>і ще {k.more} у CRM</span>}
    </div>
  );
}
