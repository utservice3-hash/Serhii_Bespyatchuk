/**
 * Борг і прострочка для «Лімітів клієнтів» — з ВАШИХ даних дебіторки (1С / CRM). Цей пакет їх не читає напряму:
 * реалізуйте DebtSource над своїми таблицями (приклад — README-TZ.md, розділ «Дебіторка → ліміти»).
 *
 * Debtor — один рядок «Боржники» активної дебіторки (обʼєднаний клієнт — один Debtor з кількома кодами).
 * Звʼязок з лімітом: debtorKey ліміту = key боржника, АБО хоч один код юрособи ліміту є в codes боржника.
 */
import type { Debtor } from '../shared/clientLimits.js';
export type { Debtor };

export interface DebtSource { debtors(): Promise<{ at: string; list: Debtor[] }> }

/** Для тестів і макета: фіксований список. */
export function staticDebtSource(at: string, list: Debtor[]): DebtSource {
  return { debtors: async () => ({ at, list: list.map(d => ({ ...d, codes: [...d.codes] })) }) };
}
/** Обгортка з кешем: дебіторка не перечитується частіше, ніж раз на ttlMs (за замовчуванням хвилина). */
export function cachedDebtSource(src: DebtSource, ttlMs = 60_000): DebtSource {
  let at = 0, val: { at: string; list: Debtor[] } | null = null, inflight: Promise<{ at: string; list: Debtor[] }> | null = null;
  return {
    async debtors() {
      if (val && Date.now() - at < ttlMs) return val;
      if (!inflight) inflight = src.debtors().then(v => { val = v; at = Date.now(); return v; }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
