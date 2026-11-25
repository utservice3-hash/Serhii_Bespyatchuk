/**
 * Поле «Банк» для карти (Тетяна 25.11.2026, #10960): обовʼязкове для нової карти й для «Вказати банк» у вже збереженої.
 * Вільний текст з підказками; список нижче лише підказує, сервер приймає будь-яку назву до 60 символів.
 */
export const BANK_HINTS = ["Монобанк", "ПриватБанк", "А-Банк", "ПУМБ", "Ощадбанк", "Райффайзен Банк", "Sense Bank", "Укрсиббанк", "Таскомбанк", "Кредобанк"];

export function BankField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="zp-field">
      <span>Банк <b className="req">*</b></span>
      <input className="zp-input" list="zc-banks" autoComplete="off" maxLength={60} placeholder="напр. Монобанк" autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id="zc-banks">{BANK_HINTS.map((b) => <option key={b} value={b} />)}</datalist>
    </label>
  );
}
/** «•••• 1234 · Монобанк» — банк поруч із номером; без банку — лише номер. */
export const cardTag = (last4: unknown, bank: unknown): string => `•••• ${String(last4 ?? "????")}${bank ? ` · ${String(bank)}` : ""}`;
