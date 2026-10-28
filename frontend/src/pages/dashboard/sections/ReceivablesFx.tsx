import { formatAmount } from "../format";

/**
 * 💱 ВАЛЮТНА ДЕБІТОРКА ВСЕРЕДИНІ ОСНОВНОЇ (Сергій 28.10.2026: «ніяким чином не поєднується з функціоналом основної»;
 * Роман 28.10 — «роби як пропонуєш»). Валютні рахунки 1С — звичайні рядки «Активної дебіторки» й «Реєстру рахунків», з
 * відповідальним, домовленістю, лімітами, списанням. Гривнева сума клієнта валюти НЕ містить (рішення А); валюта — окремим
 * рядком під нею, ≈ ₴ — довідково за курсом НБУ синку. Тут — лише показ; рахує сервер (`core/receivablesFxSql.ts`).
 */
export type Fx = { uah: number; byCurrency: Record<string, number> };
const SIGN: Record<string, string> = { EUR: "€", USD: "$" };
const MUTED = "var(--text-muted)";

export const hasFx = (fx: Fx | undefined | null): boolean => !!fx && Object.values(fx.byCurrency ?? {}).some((v) => v > 0);
export const fxText = (byCurrency: Record<string, number>): string =>
  Object.entries(byCurrency).filter(([, v]) => v > 0).map(([c, v]) => `${Math.round(v).toLocaleString("uk-UA").replace(/ /g, " ")} ${SIGN[c] ?? c}`).join(" + ");

/** Сума клієнта: гривня (якщо є) і валюта під нею. Чисто валютний клієнт — валюта головним числом. */
export function ClientAmount({ amount, fx }: { amount: number; fx: Fx | undefined }) {
  if (!hasFx(fx)) return <>{formatAmount(amount)}</>;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25 }}>
      {amount ? <span>{formatAmount(amount)}</span> : null}
      <span title="Валютний борг — окремо від гривневого; ≈ ₴ за курсом НБУ синку">
        {amount ? "+ " : ""}{fxText(fx!.byCurrency)}
        <span style={{ display: "block", fontWeight: 400, fontSize: "var(--fs-xs)", color: MUTED }}>≈ {formatAmount(fx!.uah)} ₴</span>
      </span>
    </span>
  );
}

/** Сума рахунку: гривневий — як був; валютний — у валюті, ≈ ₴ під ним. */
export function InvoiceAmount({ amount, currency, amountFx, amountFxUah }: { amount: number; currency?: string | null; amountFx?: number | null; amountFxUah?: number | null }) {
  if (!currency) return <>{formatAmount(amount)}</>;
  return (
    <span title="Валютний рахунок — до гривневої дебіторки не додається">
      {fxText({ [currency]: amountFx ?? 0 })}
      {amountFxUah != null && <span style={{ display: "block", fontWeight: 400, fontSize: "var(--fs-xs)", color: MUTED }}>≈ {formatAmount(amountFxUah)} ₴</span>}
    </span>
  );
}

/** Рядок над «Активною дебіторкою»: скільки валютного боргу й перемикач «лише валютні». */
export function FxBanner({ clients, only, toggle }: { clients: { fx?: Fx }[]; only: boolean; toggle: () => void }) {
  const fx = clients.filter((c) => hasFx(c.fx));
  if (!fx.length && !only) return null;
  const by: Record<string, number> = {};
  for (const c of fx) for (const [k, v] of Object.entries(c.fx!.byCurrency)) by[k] = (by[k] ?? 0) + v;
  const uah = fx.reduce((a, c) => a + (c.fx?.uah ?? 0), 0);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "0 0 12px", padding: "8px 12px", border: "1px dashed var(--border)", borderRadius: 8, fontSize: "var(--fs-sm)" }}>
      <span>
        Валютна дебіторка: <b>{fxText(by) || "—"}</b>{uah ? <span style={{ color: MUTED }}> (≈ {formatAmount(uah)} ₴)</span> : null} · {fx.length} клієнт.
        <span style={{ color: MUTED }}> До гривневої суми не додається.</span>
      </span>
      <button type="button" onClick={toggle} aria-pressed={only}
        style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "2px 10px", background: only ? "var(--brand, #c5141c)" : "var(--card-bg)", color: only ? "#fff" : "var(--text)", cursor: "pointer", font: "inherit", fontSize: "var(--fs-xs)" }}>
        {only ? "Показати всіх" : "Лише валютні"}
      </button>
    </div>
  );
}
