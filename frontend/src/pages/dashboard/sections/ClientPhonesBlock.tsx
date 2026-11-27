import type { CSSProperties } from "react";
import type { ClientCard } from "../../../api";

/**
 * ☎️ «НОМЕРИ КЛІЄНТА» В КАРТЦІ (задача 11223; Роман 27.11.2026: «давай записувати номери окремо, щоб ми бачили всі
 * номери клієнта постійного»).
 *
 * Кожен номер — рядок: звідки він (з переходом у Kommo), скільки розмов за вікно і коли остання. Що саме показати й у
 * якому порядку, вирішує сервер (`core/clientPhoneBook.ts`, гейти `#11252`–`#11254`); тут лише вигляд.
 *
 * 🔴 «Розмов N» і «привʼязано M» — два різні числа, і зводити їх в одне не можна: номер лише з картки компанії клієнту
 * розмов не дає, і саме це людина має побачити (щоб перенести номер у контакт у Kommo), а не прочитати як «усе гаразд».
 */
type Phone = NonNullable<ClientCard["phones"]>["list"][number];

const pill = (bg: string, fg: string, bd: string): CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, lineHeight: 1.2, padding: "2px 8px",
  borderRadius: 999, border: `1px solid ${bd}`, background: bg, color: fg, textDecoration: "none", whiteSpace: "nowrap",
});
const BLUE = pill("#eff6ff", "#1d4ed8", "#bfdbfe");
const GRAY = pill("#f3f4f6", "#374151", "#e5e7eb");
const AMBER = pill("#fffbeb", "#b45309", "#fde68a");
const RED = pill("#fef2f2", "#b91c1c", "#fecaca");

const SOURCE: Record<Phone["source"], string> = { contact: "контакт", company: "картка компанії", key: "номер клієнта" };

/** 380671112233 → +380 67 111 22 33; усе інше — як є, з плюсом. */
export function prettyPhone(p: string): string {
  const m = /^380(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p);
  return m ? `+380 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : /^\d+$/.test(p) ? `+${p}` : p;
}
const talksWord = (n: number): string => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "розмова" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "розмови" : "розмов";
};
const dayShort = (d: string): string => d.slice(5).split("-").reverse().join(".");
const clientsWord = (n: number): string => (n === 1 ? "клієнт" : n >= 2 && n <= 4 ? "клієнти" : "клієнтів");

function TalksCell({ p }: { p: Phone }) {
  if (p.talks === 0) return <span style={{ color: "#9ca3af" }}>розмов не було</span>;
  const base = `${String(p.talks)} ${talksWord(p.talks)}${p.lastDay ? ` · остання ${dayShort(p.lastDay)}` : ""}`;
  if (p.state === "carrier") return <span style={{ color: "#6b7280" }} title="номер у довіднику перевізників — розмови по ньому клієнту не рахуються">{base} · не враховано</span>;
  if (p.linked === p.talks) return <span>{base}</span>;
  return (
    <span style={{ color: "#b45309" }}
      title={p.state === "unlinked"
        ? "номер стоїть лише в картці компанії: розмови привʼязуються до клієнта за номерами контактів. Додайте номер у контакт у Kommo"
        : "частина розмов на цьому номері привʼязана до іншого клієнта"}>
      {base} · клієнту зараховано {p.linked}
    </span>
  );
}

export function ClientPhonesBlock({ card }: { card: ClientCard }) {
  const b = card.phones;
  if (!b || b.list.length === 0) return null;
  return (
    <div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px", background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>
        <span>Номери клієнта · {b.total}</span>
        <span>розмови за {b.days} днів</span>
      </div>
      {b.list.map((p, i) => (
        <div key={p.phone} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "6px 0", fontSize: 12.5,
          borderTop: i === 0 ? "none" : "1px solid #f3f4f6" }}>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 138 }}>{prettyPhone(p.phone)}</span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 4, flex: 1, minWidth: 0 }}>
            {p.url
              ? <a href={p.url} target="_blank" rel="noreferrer" style={BLUE} title="Відкрити в Kommo">{SOURCE[p.source]} <span aria-hidden>↗</span></a>
              : <span style={GRAY}>{SOURCE[p.source]}</span>}
            {p.source === "company" && p.company && <span style={{ ...GRAY, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{p.company}</span>}
            {p.sharedWith > 0 && (
              <span style={AMBER} title="цей номер є в контактах ще й інших клієнтів">спільний · ще {p.sharedWith} {clientsWord(p.sharedWith)}</span>
            )}
            {p.carrier && <span style={RED}>перевізник{p.carrier.lardi ? " · Ларді" : p.carrier.history ? " · історія CRM" : ""}</span>}
          </span>
          <span style={{ marginLeft: "auto", textAlign: "right" }}><TalksCell p={p} /></span>
        </div>
      ))}
      {b.more > 0 && <div style={{ fontSize: 11.5, color: "#6b7280", paddingTop: 4 }}>і ще {b.more} — у Kommo</div>}
      <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 6, lineHeight: 1.45 }}>
        Номери з контактів угод і з картки компанії в Kommo. Розмови зараховуються клієнту лише за номерами з контактів.
      </div>
    </div>
  );
}
