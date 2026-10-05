import { kommoGet, kommoDelete } from "../kommo/client.js";
import { shouldDeclineUnsorted, phonesOfUnsorted, declinedRowOf } from "../core/kommoSpamRules.js";
import { pool } from "../db/pool.js";

/**
 * 🛡 АВТОВІДХИЛЕННЯ СПАМ-ЗАЯВОК У «НЕРОЗІБРАНОМУ» KOMMO (слово Романа 23.09.2026).
 * Кожні 3 хв читає заявки з форм і відхиляє ті, що без справжнього телефону — правило в
 * чистому `core/kommoSpamRules.ts`. Відхилення в Kommo безповоротне (заявка й порожній контакт
 * видаляються), тому: лише category=forms, лише за правилом, стеля на тік, і кожен тік пише
 * числа в результат (скільки переглянуто / відхилено / помилок) — порожній результат мусить
 * бути видимим як «0 із N», а не тишею.
 *
 * 🧾 ЖУРНАЛ (05.10.2026): кожна заявка лягає в `kommo_declined_forms` ПЕРЕД відхиленням, бо після нього
 * від неї не лишається нічого, а серверний лог живе добу. Не записалась — НЕ відхиляємо: заявка почекає
 * наступного тіку в «Нерозібраному», а не зникне без сліду. Тримає #1362b.
 */
export const DECLINE_CAP_PER_TICK = 300;

export async function declineSpamForms(): Promise<{ scanned: number; declined: number; failed: number }> {
  let page = 1, scanned = 0, declined = 0, failed = 0;
  const targets: { uid: string; raw: unknown }[] = [];
  while (page <= 8) {
    const r = await kommoGet<{ _embedded?: { unsorted?: { uid: string; category?: string; _embedded?: unknown }[] } }>(
      `/api/v4/leads/unsorted?filter[category][]=forms&limit=250&page=${page}`);
    const items = r?._embedded?.unsorted ?? [];
    if (!items.length) break;
    for (const u of items) {
      scanned++;
      if (shouldDeclineUnsorted({ category: u.category, phones: phonesOfUnsorted(u as Parameters<typeof phonesOfUnsorted>[0]) })) targets.push({ uid: u.uid, raw: u });
    }
    page++;
  }
  for (const { uid, raw } of targets.slice(0, DECLINE_CAP_PER_TICK)) {
    const row = declinedRowOf(raw as Parameters<typeof declinedRowOf>[0]);
    try {
      await pool.query(
        `INSERT INTO kommo_declined_forms (uid, received_at, form_name, form_page, ip, contact_name, email, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (uid) DO UPDATE SET state = 'pending', error = NULL`,
        [uid, row?.receivedAt ?? null, row?.formName ?? null, row?.formPage ?? null, row?.ip ?? null,
         row?.contactName ?? null, row?.email ?? null, JSON.stringify(raw)]);
    } catch (e) { failed++; console.error("declineSpamForms: журнал не записався, НЕ відхиляю", uid, (e as Error).message.slice(0, 120)); continue; }
    let state: "declined" | "failed" = "declined", msg: string | null = null;
    try { await kommoDelete(`/api/v4/leads/unsorted/${uid}/decline`); declined++; }
    catch (e) { state = "failed"; failed++; msg = (e as Error).message.slice(0, 120); console.error("declineSpamForms:", uid, msg); }
    // Заявка вже або відхилена, або ні — помилка тут лишає рядок у `pending`, і це видно, а не губиться.
    await pool.query(`UPDATE kommo_declined_forms SET state = $2, error = $3, declined_at = CASE WHEN $2 = 'declined' THEN now() END WHERE uid = $1`,
      [uid, state, msg]).catch((e) => console.error("declineSpamForms: стан у журнал не записався", uid, (e as Error).message.slice(0, 120)));
  }
  if (targets.length) console.log(`declineSpamForms: переглянуто ${scanned}, без телефону ${targets.length}, відхилено ${declined}, помилок ${failed}`);
  return { scanned, declined, failed };
}
