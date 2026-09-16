/**
 * 📖 ОЗНАЙОМЛЕННЯ З РЕГЛАМЕНТАМИ — чисте правило без БД (розділ 8 ТЗ «ознайомились 14/19»,
 * рішення власника 15.09.2026: «статус і нагадування, без блокування»).
 *
 *  - Потрібне лише для ЗАГАЛЬНИХ документів типу «Регламент», не в архіві. Інструкції, шаблони,
 *    матеріали — читаються, але «ознайомлення» з них не вимагаємо (#445).
 *  - Позначка привʼязана до ВЕРСІЇ І ХЕША, як підпис: нова версія — читати заново.
 *  - Прогрес рахується ЛИШЕ по аудиторії (хто мусить прочитати), а не по всіх, хто натиснув:
 *    інакше «14/19» плаває від того, хто зайшов випадково.
 *  - Нагадування — тим із аудиторії, хто не прочитав і має привʼязаний Telegram (#445b).
 */

export interface AckDoc { section: string; category: string | null; archivedAt: Date | string | null; version: number; sha256: string | null }
export interface AckRow { userId: number; version: number; sha256: string }

export const ACK_CATEGORY = "Регламент";

export function ackRequired(d: Pick<AckDoc, "section" | "category" | "archivedAt">): boolean {
  return d.section === "general" && d.category === ACK_CATEGORY && d.archivedAt == null;
}

/** Чи прочитав користувач ПОТОЧНУ версію. */
export function ackedCurrent(d: Pick<AckDoc, "version" | "sha256">, acks: readonly AckRow[], userId: number): boolean {
  return acks.some((a) => a.userId === userId && a.version === d.version && a.sha256 === d.sha256);
}

export type AckMine = "not_required" | "acked" | "pending";
export function ackMine(d: AckDoc, acks: readonly AckRow[], userId: number): AckMine {
  if (!ackRequired(d)) return "not_required";
  return ackedCurrent(d, acks, userId) ? "acked" : "pending";
}

/** Прогрес по аудиторії: done ⊆ audience; хто натиснув поза аудиторією — не рахується. */
export function ackProgress(d: Pick<AckDoc, "version" | "sha256">, audience: readonly number[], acks: readonly AckRow[]): { total: number; done: number; missing: number[] } {
  const set = new Set(audience);
  const doneIds = new Set(acks.filter((a) => a.version === d.version && a.sha256 === d.sha256 && set.has(a.userId)).map((a) => a.userId));
  return { total: set.size, done: doneIds.size, missing: audience.filter((u) => !doneIds.has(u)) };
}

/** Кому нагадувати: лише ті з `missing`, у кого є чат. Повертає й тих, кому нема куди. */
export function remindTargets(missing: readonly number[], chatByUser: ReadonlyMap<number, string | number | null | undefined>): { send: { userId: number; chatId: string | number }[]; noTelegram: number[] } {
  const send: { userId: number; chatId: string | number }[] = []; const noTelegram: number[] = [];
  for (const u of missing) { const c = chatByUser.get(u); if (c) send.push({ userId: u, chatId: c }); else noTelegram.push(u); }
  return { send, noTelegram };
}
