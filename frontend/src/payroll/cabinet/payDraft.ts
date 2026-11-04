/** Чернетка форми «куди виплатити» (форма на виплату ЗП і заявка на аванс) і тіло запиту з неї. */
import type { Obj } from "../api";

export interface PayLine { card: number | "new"; amount: number; number: string; holder: string }
export interface PayDraft { cash: number; lines: PayLine[] }

export function initDraft(cards: Obj[], total: number, holder: string): PayDraft {
  const amt = Math.max(0, Math.round(total));
  return { cash: 0, lines: [cards.length ? { card: Number(cards[0].id), amount: amt, number: "", holder: "" } : { card: "new", amount: amt, number: "", holder }] };
}
/** → тіло запиту: `{ cash, lines: [{ cardId, amount } | { newCard: { number, holder }, amount }] }`. */
export function draftBody(d: PayDraft): { cash: number; lines: Obj[] } {
  return {
    cash: d.cash || 0,
    lines: d.lines.filter((l) => l.amount > 0).map((l) => (l.card === "new"
      ? { newCard: { number: l.number.replace(/\s/g, ""), holder: l.holder.trim() }, amount: l.amount }
      : { cardId: l.card, amount: l.amount })),
  };
}
export const draftTotal = (d: PayDraft) => (d.cash || 0) + d.lines.reduce((s, l) => s + (l.amount || 0), 0);

