/**
 * Клієнти ВАШОЇ бази для «＋ Додати клієнта» у «Лімітах клієнтів» (задача 7137, Сергій 26.10: ліміт можна дати й тому, кого
 * немає в дебіторці). Як і DebtSource, пакет базу напряму не читає — реалізація над нашими таблицями: counterparty/clientDirectoryDb.ts.
 */
import type { ClientHit } from '../shared/clientLimits.js';
export type { ClientHit };

export interface ClientDirectory {
  /** До 20 клієнтів за кодом (точно) або назвою (частина). */
  search(q: { code: string } | { text: string }): Promise<ClientHit[]>;
  /** Один клієнт за ключем; null — такого в базі немає. */
  get(key: string): Promise<ClientHit | null>;
}
