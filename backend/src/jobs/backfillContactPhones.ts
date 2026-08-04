/**
 * ☎️ БЕКФІЛ ТЕЛЕФОНІВ КОНТАКТІВ KOMMO → `contact_phones` (+ добудова `deal_contacts`).
 *
 * 🔴 НАВІЩО. До цієї джоби телефонів у базі НЕ БУЛО ВЗАГАЛІ: `deal_contacts`
 * зберігає лише `contact_id`, а номер існував тільки як `client_key` фізособи.
 * Без телефонів звʼязати дзвінок Ringostat із клієнтом нічим.
 *
 * 🔴 І ДРУГА ДІРКА, ЗАМІРЯНА ПЕРЕД ЗАПУСКОМ: `deal_contacts` покриває лише
 * 35 143 угоди зі 146 457 (24%). Штатний синк пише лінк лише для угод свого
 * вікна, тож угоди, які давно не рухались, звʼязку не мають. Тому джоба тягне
 * контакти ПО ВСІХ угодах, а не лише по тих, у кого лінк уже є.
 *
 * 🔒 ПІД `job_locks` І З ТРОТЛІНГОМ. Це важка Kommo-джоба: ~600 запитів по 250.
 * Без замка вона зіштовхнеться з `syncKommo` — рівно те, що дало інцидент
 * 03.08.2026 (дублі пар) і дедлок міграції. Замок змушує синк пропускати прохід.
 */
import { pool } from "../db/pool.js";
import { fetchLeadsByIds, fetchContactsByIds, type KommoContact } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";
import { normalizePhone } from "../utils/phone.js";
import { dedupeDealContactPairs, type DealContactPair } from "./dealContactPairs.js";

/** УСІ телефони контакту, не лише перший. `extractPhone` бере [0] — цього мало. */
export function allPhones(c: KommoContact): { raw: string; norm: string }[] {
  const f = c.custom_fields_values?.find((x) => x.field_code === "PHONE");
  const out: { raw: string; norm: string }[] = [];
  for (const v of f?.values ?? []) {
    const raw = String(v?.value ?? "").trim();
    const norm = normalizePhone(raw);
    if (raw && norm) out.push({ raw, norm });
  }
  return out;
}

export interface PhoneBackfillResult {
  dealsScanned: number; kommoRequests: number;
  linksBefore: number; linksAfter: number;
  contactsSeen: number; contactsWithPhone: number; phonesWritten: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @param opts.batch     угод на один запит до Kommo (250 — межа API)
 * @param opts.pauseMs   пауза МІЖ пачками (тротлінг: після IP-бану 08.07.2026 темп свідомо низький)
 * @param opts.maxDeals  стеля для пробного прогону; 0 = усі
 * @param opts.fromKommoId  РЕЗЮМЕ-КУРСОР: почати з угод `kommo_id >= N`.
 *
 * 🔴 НАВІЩО КУРСОР (урок 04.08.2026, заміряний). Перший прогін хостинг убив на
 * 35 250 угоді зі 146 481 (24%) — процес зник, `job_locks` лишився з мертвим
 * heartbeat, у логу жодної помилки. Без курсора єдиний спосіб продовжити — знову
 * пройти вже зроблені 35 тис. (це ~140 зайвих запитів до Kommo, тобто рівно те,
 * через що ми колись отримали IP-бан). Це ТОЙ САМИЙ клас, що «вотермарк
 * все-або-нічого» в event-джобах: збій має коштувати ПОРЦІЮ, а не весь прогін.
 * Тому джоба друкує курсор у кожному прогрес-рядку, а перезапуск бере його.
 */
export async function backfillContactPhones(
  opts: { batch?: number; pauseMs?: number; maxDeals?: number; fromKommoId?: number } = {}
): Promise<PhoneBackfillResult> {
  const batch = opts.batch ?? 250;
  const pauseMs = opts.pauseMs ?? 1200;

  return withHeavyJobLock("backfillContactPhones", async () => {
    const linksBefore = Number((await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT deal_kommo_id) n FROM deal_contacts`)).rows[0].n);

    const from = opts.fromKommoId ?? 0;
    const ids = (await pool.query<{ kommo_id: string }>(
      `SELECT kommo_id FROM deals WHERE kommo_id >= $1 ORDER BY kommo_id`, [from]))
      .rows.map((r) => Number(r.kommo_id));
    if (from > 0) console.log(`  резюме з kommo_id >= ${from}: до обробки ${ids.length} угод`);
    const scoped = opts.maxDeals ? ids.slice(0, opts.maxDeals) : ids;

    let requests = 0, phonesWritten = 0;
    const seen = new Set<number>(), withPhone = new Set<number>();

    for (let i = 0; i < scoped.length; i += batch) {
      const leads = await fetchLeadsByIds(scoped.slice(i, i + batch));
      requests++;

      // 1) добудовуємо `deal_contacts` — саме тут закривається дірка 24%.
      const raw: DealContactPair[] = [];
      for (const l of leads) {
        for (const c of l._embedded?.contacts ?? []) {
          raw.push({ dealId: l.id, contactId: c.id, isMain: c.is_main === true });
        }
      }
      const pairs = dedupeDealContactPairs(raw);   // 🔴 урок 03.08.2026
      if (pairs.length) {
        await pool.query(
          `INSERT INTO deal_contacts (deal_kommo_id, contact_id, is_main, updated_at)
           SELECT * FROM (SELECT UNNEST($1::bigint[]) d, UNNEST($2::bigint[]) c,
                                 UNNEST($3::boolean[]) m, now() u) v
           ON CONFLICT (deal_kommo_id, contact_id) DO UPDATE
             SET is_main = EXCLUDED.is_main, updated_at = now()`,
          [pairs.map((p) => p.dealId), pairs.map((p) => p.contactId), pairs.map((p) => p.isMain)]);
      }

      // 2) телефони самих контактів
      const contactIds = [...new Set(pairs.map((p) => p.contactId))].filter((id) => !seen.has(id));
      for (let j = 0; j < contactIds.length; j += 250) {
        const contacts = await fetchContactsByIds(contactIds.slice(j, j + 250));
        requests++;
        const rows: { id: number; raw: string; norm: string; main: boolean }[] = [];
        for (const c of contacts) {
          seen.add(c.id);
          const phones = allPhones(c);
          if (phones.length) withPhone.add(c.id);
          phones.forEach((p, k) => rows.push({ id: c.id, raw: p.raw, norm: p.norm, main: k === 0 }));
        }
        // Дедуп пар (contact_id, phone) — той самий PK-клас, що поклав синк.
        const uniq = new Map(rows.map((r) => [`${r.id}|${r.norm}`, r]));
        const list = [...uniq.values()];
        if (list.length) {
          const r = await pool.query(
            `INSERT INTO contact_phones (contact_id, phone, raw_phone, is_main, updated_at)
             SELECT * FROM (SELECT UNNEST($1::bigint[]) c, UNNEST($2::text[]) p,
                                   UNNEST($3::text[]) rp, UNNEST($4::boolean[]) m, now() u) v
             ON CONFLICT (contact_id, phone) DO UPDATE
               SET raw_phone = EXCLUDED.raw_phone, is_main = EXCLUDED.is_main, updated_at = now()`,
            [list.map((x) => x.id), list.map((x) => x.norm), list.map((x) => x.raw), list.map((x) => x.main)]);
          phonesWritten += r.rowCount ?? 0;
        }
        await sleep(pauseMs);
      }
      await sleep(pauseMs);
      if ((i / batch) % 20 === 0) {
        // Курсор друкуємо ЗАВЖДИ: без нього рядок прогресу каже «скільки», але не «звідки
        // продовжити», і вбитий прогін доводиться починати спочатку.
        const cursor = scoped[Math.min(i + batch, scoped.length - 1)];
        console.log(`  ${i + leads.length}/${scoped.length} угод · контактів ${seen.size} · телефонів ${phonesWritten} · курсор ${cursor}`);
      }
    }

    const linksAfter = Number((await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT deal_kommo_id) n FROM deal_contacts`)).rows[0].n);
    return {
      dealsScanned: scoped.length, kommoRequests: requests,
      linksBefore, linksAfter,
      contactsSeen: seen.size, contactsWithPhone: withPhone.size, phonesWritten,
    };
  });
}
