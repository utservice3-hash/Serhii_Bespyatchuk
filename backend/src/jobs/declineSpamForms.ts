import { kommoGet, kommoDelete } from "../kommo/client.js";
import { shouldDeclineUnsorted, phonesOfUnsorted } from "../core/kommoSpamRules.js";

/**
 * 🛡 АВТОВІДХИЛЕННЯ СПАМ-ЗАЯВОК У «НЕРОЗІБРАНОМУ» KOMMO (слово Романа 23.09.2026).
 * Кожні 3 хв читає заявки з форм і відхиляє ті, що без справжнього телефону — правило в
 * чистому `core/kommoSpamRules.ts`. Відхилення в Kommo безповоротне (заявка й порожній контакт
 * видаляються), тому: лише category=forms, лише за правилом, стеля на тік, і кожен тік пише
 * числа в результат (скільки переглянуто / відхилено / помилок) — порожній результат мусить
 * бути видимим як «0 із N», а не тишею.
 */
export const DECLINE_CAP_PER_TICK = 300;

export async function declineSpamForms(): Promise<{ scanned: number; declined: number; failed: number }> {
  let page = 1, scanned = 0, declined = 0, failed = 0;
  const targets: string[] = [];
  while (page <= 8) {
    const r = await kommoGet<{ _embedded?: { unsorted?: { uid: string; category?: string; _embedded?: unknown }[] } }>(
      `/api/v4/leads/unsorted?filter[category][]=forms&limit=250&page=${page}`);
    const items = r?._embedded?.unsorted ?? [];
    if (!items.length) break;
    for (const u of items) {
      scanned++;
      if (shouldDeclineUnsorted({ category: u.category, phones: phonesOfUnsorted(u as Parameters<typeof phonesOfUnsorted>[0]) })) targets.push(u.uid);
    }
    page++;
  }
  for (const uid of targets.slice(0, DECLINE_CAP_PER_TICK)) {
    try { await kommoDelete(`/api/v4/leads/unsorted/${uid}/decline`); declined++; }
    catch (e) { failed++; console.error("declineSpamForms:", uid, (e as Error).message.slice(0, 120)); }
  }
  if (targets.length) console.log(`declineSpamForms: переглянуто ${scanned}, без телефону ${targets.length}, відхилено ${declined}, помилок ${failed}`);
  return { scanned, declined, failed };
}
