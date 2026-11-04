/**
 * Форма «куди виплатити» — спільна для форми на виплату ЗП і заявки на аванс (макет `c04-pay.js`, `plHtml`):
 * одна чи кілька карт (збережені або нова — номер і отримувач) + частина готівкою. До 4 карт.
 * Перевірку Луна, дублікатів і «сходиться на копійку» робить сервер (`checkPayoutForm` рушія) — тут лише підказка «лишилось».
 */
import { useMemo, useState } from "react";
import type { Obj } from "../api";
import { money } from "../ui";
import { draftTotal, type PayDraft, type PayLine } from "./payDraft";

const toNum = (s: string) => { const n = Number(String(s).replace(/[\s ₴]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const fmtCard = (s: string) => s.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ");

export function PayLines({ cards, draft, onChange, due, dueLabel, defaultHolder }: {
  cards: Obj[]; draft: PayDraft; onChange: (d: PayDraft) => void;
  /** Скільки має бути разом (форма на виплату — рівно; аванс — не більше). */
  due: number; dueLabel: "exact" | "max"; defaultHolder: string;
}) {
  const many = draft.lines.length > 1;
  const total = draftTotal(draft);
  const rest = Math.round(due - total);
  const set = (i: number, patch: Partial<PayLine>) => onChange({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const usedCards = useMemo(() => new Set(draft.lines.map((l) => l.card)), [draft.lines]);
  const [cashOpen, setCashOpen] = useState(draft.cash > 0);

  return (
    <div className="zc-pl">
      <div className="zp-k">На карти</div>
      {draft.lines.map((l, i) => (
        <div key={i} className="zc-pl__line">
          <label className="zp-field">
            <span>Карта{many ? ` ${i + 1}` : ""}</span>
            <select className="zp-select" value={String(l.card)} onChange={(e) => set(i, { card: e.target.value === "new" ? "new" : Number(e.target.value), holder: e.target.value === "new" && !l.holder ? defaultHolder : l.holder })}>
              {cards.map((c) => (
                <option key={c.id} value={c.id} disabled={usedCards.has(Number(c.id)) && l.card !== Number(c.id)}>•••• {c.last4} · {String(c.holder).split(" ").slice(0, 2).join(" ")}</option>
              ))}
              <option value="new">+ Нова карта</option>
            </select>
          </label>
          <label className="zp-field zc-pl__amt">
            <span>Сума, ₴</span>
            <input className="zp-input zp-input--num" inputMode="numeric" value={l.amount ? String(l.amount) : ""} placeholder="0" onChange={(e) => set(i, { amount: toNum(e.target.value) })} />
          </label>
          {many ? <button type="button" className="zp-btn zp-btn--ghost zp-btn--sm zc-pl__x" aria-label={`Прибрати карту ${i + 1}`} onClick={() => onChange({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>✕</button> : <span />}
          {l.card === "new" && (
            <div className="zc-pl__new">
              <label className="zp-field">
                <span>Номер карти</span>
                <input className="zp-input zp-num" inputMode="numeric" autoComplete="off" placeholder="0000 0000 0000 0000" value={fmtCard(l.number)} onChange={(e) => set(i, { number: e.target.value.replace(/\D/g, "") })} />
              </label>
              <label className="zp-field">
                <span>Отримувач — прізвище, імʼя (як у банку)</span>
                <input className="zp-input" autoComplete="off" value={l.holder} onChange={(e) => set(i, { holder: e.target.value })} />
              </label>
            </div>
          )}
        </div>
      ))}
      <div className="zp-row">
        <button type="button" className="zp-btn zp-btn--sm" disabled={draft.lines.length >= 4}
          onClick={() => {
            const free = cards.find((c) => !usedCards.has(Number(c.id)));
            onChange({ ...draft, lines: [...draft.lines, free ? { card: Number(free.id), amount: Math.max(0, rest), number: "", holder: "" } : { card: "new", amount: Math.max(0, rest), number: "", holder: defaultHolder }] });
          }}>+ Ще одна карта</button>
        {!cashOpen && <button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setCashOpen(true)}>+ Частину готівкою</button>}
      </div>
      {cashOpen && (
        <label className="zp-field zc-pl__cash">
          <span>Готівкою, ₴</span>
          <input className="zp-input zp-input--num" inputMode="numeric" value={draft.cash ? String(draft.cash) : ""} placeholder="0" onChange={(e) => onChange({ ...draft, cash: toNum(e.target.value) })} />
        </label>
      )}
      <div className={`zc-pl__sum ${dueLabel === "exact" ? (rest === 0 ? "is-ok" : "is-bad") : rest < 0 ? "is-bad" : ""}`}>
        Разом <b className="zp-num">{money(total)}</b>
        {dueLabel === "exact"
          ? rest === 0 ? <> · сходиться з «До виплати»</> : <> · {rest > 0 ? `лишилось розподілити ${money(rest)}` : `більше на ${money(-rest)}`} (має бути {money(due)})</>
          : rest < 0 ? <> · більше ліміту на {money(-rest)}</> : <> · можна до {money(due)}</>}
      </div>
    </div>
  );
}
