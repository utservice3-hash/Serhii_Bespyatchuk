import type { Db } from "./adCallFacts.js";
import { INBOUND_TYPES, MISSED_DISPOSITIONS } from "./missedCallsRules.js";

/**
 * 🔎 НОМЕР ПРОПУЩЕНОГО, ЯКИЙ ЗНАХОДИТЬ ЛАРДІ, — ПЕРЕВІЗНИК (рішення Романа 25.11.2026, дослівно: «рахувати за реєстром
 * ларді теж, якщо ларді каже що такий номер знайдено це автоматом перевізник, не тільки по архіву а взагалом»; після
 * розбору трьох знайдених номерів: «давай все робити щоб всі номери це перевізники»). Скасовує рішення 20.11.2026
 * «вантажі й сама реєстрація на Ларді перевізником не роблять» — тепер ні вантажі, ні тип компанії, ні КВЕД значення
 * не мають: Ларді знайшов користувача з цим номером → перевізник.
 *
 * Привід — 380971794867 (25.11, «не впізнано в CRM»): ФОП-перевізник, зареєстрований на Ларді, у нашому архіві машин
 * не виставляв і в CRM «Перевізником» не закривався, тож довідник його не знав. Замір 25.11 по живому API: за 23.11
 * Ларді знаходить 8 з 23 номерів «Чекають».
 *
 * Як: кожні 5 хв (Роман 25.11.2026: «давай цю джобу частіше ранити») джоба `lardiPhoneLookup` бере номери пропущених
 * за `LOOKUP_DAYS`, яких ще немає в довіднику, і питає
 * Ларді «пошук користувача» (`GET /v2/users/search`, базовий API, той самий виклик, що в «Перевірити номер на Ларді»,
 * `core/lardiCheck.ts`). Результат — у `lardi_phone_lookup`; перебудова довідника (`core/carrierPhones.ts`) бере звідти
 * знайдені номери. Знайшли хоч один — джоба одразу перебудовує довідник (`onFound`), не чекаючи :22: номер зникає
 * з «Чекають» за ~5 хв після дзвінка, а не за годину. YouControl не кличемо: тип компанії для правила не потрібен.
 *
 * 🔴 «ЛАРДІ НЕ ВІДПОВІВ» ≠ «НЕ ЗНАЙДЕНО». Збій не пишеться взагалі: номер лишається неперевіреним і піде в наступну
 * прохід. Інакше 403 (не оплачено API) за годину тихо записав би сотні номерів «клієнтами» на тиждень.
 *
 * Перевіряємо лише номери пропущених, не всі номери клієнтів: правило Романа — про екран пропущених. На екрані клієнтів
 * позначка «Lardi» з'являється тільки для тих номерів, що пропускали дзвінки. «Відсів» (закриття угод у Kommo) цю
 * таблицю не читає — він і далі закриває лише за машинами Ларді й історією CRM.
 *
 * Модуль чистий (без `pool`): SQL, правила й прохід із пошуком параметром — гейти підставляють свій пошук.
 */

/** Вікно пропущених, номери яких перевіряємо: місяць екрана + запас. */
export const LOOKUP_DAYS = 35;
/** Знайдений номер перевіряємо знову через стільки днів — раптом профіль видалили. */
export const RECHECK_FOUND_DAYS = 30;
/**
 * Не знайдений — через стільки днів: номери з'являються на Ларді в середньому через 7–8 днів після дзвінка
 * (замір 19.11.2026, `docs/sql/carrier-lardi-missed-2026-11-19.cjs`).
 */
export const RECHECK_MISSING_DAYS = 7;
/** Стеля запитів до Ларді за прохід (запас на випадок, коли черга велика — після простою чи першого запуску). */
export const LOOKUP_PER_RUN = 300;
/** Пауза між запитами до Ларді. */
export const LOOKUP_PAUSE_MS = 1500;
/**
 * Стеля часу проходу: 4 хв при кроні кожні 5 хв — прохід закінчується до наступного тіку, тож два проходи не
 * питають Ларді одночасно. Решта черги піде наступним тіком. Звичайний тік — кілька нових номерів, секунди.
 */
export const LOOKUP_BUDGET_MS = 4 * 60_000;

/** Що відповів Ларді на один номер. `ok=false` — не 200 (стан у `status`), це НЕ «не знайдено». */
export interface LardiSearchResult { ok: boolean; status: number; users: ReadonlyArray<{ name: string }> }
export type LardiSearch = (p9: string) => Promise<LardiSearchResult>;

/** Рядок для `lardi_phone_lookup` або `null`, якщо Ларді не відповів (нічого не пишемо). */
export function lookupRow(r: LardiSearchResult): { users: number; name: string | null } | null {
  if (!r.ok) return null;
  return { users: r.users.length, name: r.users.map((u) => u.name).filter(Boolean).join("; ").slice(0, 200) || null };
}

/** Знайдено на Ларді = перевізник. Будь-який користувач, без огляду на вантажі, машини чи КВЕД. */
export const isLardiCarrier = (users: number): boolean => users > 0;

/** Чи час перевірити номер знову. `last` — останній УСПІШНИЙ результат (збої не пишуться). */
export function dueForLookup(last: { checkedAt: Date; users: number } | null, now: Date): boolean {
  if (!last) return true;
  const days = isLardiCarrier(last.users) ? RECHECK_FOUND_DAYS : RECHECK_MISSING_DAYS;
  return now.getTime() - last.checkedAt.getTime() >= days * 86_400_000;
}

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

/**
 * Кандидати: українські номери (380 + 9 цифр) пропущених вхідних за `$1` днів, яких немає в довіднику з ІНШИХ джерел
 * (машини Ларді, історія CRM) і яким настав час перевірки (та сама межа, що `dueForLookup`: `$2` — знайдені, `$3` —
 * не знайдені). Спершу ніколи не перевірені, далі — найсвіжіший дзвінок. `$4` — стеля.
 */
export const LOOKUP_CANDIDATES_SQL = `
  WITH m AS (
    SELECT right(rc.client_phone, 9) AS p9, max(rc.calldate) AS last_call
      FROM ringostat_calls rc
     WHERE rc.call_type IN (${list(INBOUND_TYPES)}) AND rc.billsec = 0 AND rc.disposition IN (${list(MISSED_DISPOSITIONS)})
       AND rc.calldate >= now() - make_interval(days => $1::int)
       AND rc.client_phone ~ '^380[0-9]{9}$'
     GROUP BY 1)
  SELECT m.p9
    FROM m LEFT JOIN lardi_phone_lookup l ON l.p9 = m.p9
   WHERE NOT EXISTS (SELECT 1 FROM carrier_phones c WHERE c.p9 = m.p9 AND (c.via_lardi OR c.via_history))
     AND (l.p9 IS NULL
          OR (l.users > 0 AND l.checked_at <= now() - make_interval(days => $2::int))
          OR (l.users = 0 AND l.checked_at <= now() - make_interval(days => $3::int)))
   ORDER BY (l.p9 IS NULL) DESC, m.last_call DESC, m.p9
   LIMIT $4::int`;

export const LOOKUP_UPSERT_SQL = `
  INSERT INTO lardi_phone_lookup (p9, checked_at, users, name) VALUES ($1, now(), $2, $3)
  ON CONFLICT (p9) DO UPDATE SET checked_at = now(), users = EXCLUDED.users, name = EXCLUDED.name`;

export interface LookupReport {
  candidates: number; checked: number; found: number;
  /** Прохід зупинено стелею часу `LOOKUP_BUDGET_MS`; решта кандидатів — наступним тіком. */
  outOfTime: boolean;
  /** Ларді не відповів 200 — прохід зупинено на цьому номері; `status` першого збою. */
  failed: number; failStatus: number | null;
}

/**
 * Прохід: по одному запиту на номер, з паузою. Перший збій зупиняє прохід (Ларді лімітує чи відмовляє — далі буде те
 * саме). Збій на ПЕРШОМУ ж номері — помилка джоби: інакше відмова Ларді (403) годинами йшла б «успіхом» із нулем, як
 * було з архівом цін 17.09–12.10.2026.
 */
export async function lookupMissedPhones(
  db: Db, search: LardiSearch,
  o: { limit?: number; pauseMs?: number; budgetMs?: number; onFound?: () => Promise<unknown> } = {},
): Promise<LookupReport> {
  const limit = o.limit ?? LOOKUP_PER_RUN, pauseMs = o.pauseMs ?? LOOKUP_PAUSE_MS, budgetMs = o.budgetMs ?? LOOKUP_BUDGET_MS;
  const started = Date.now();
  const cand = (await db.query<{ p9: string }>(LOOKUP_CANDIDATES_SQL, [LOOKUP_DAYS, RECHECK_FOUND_DAYS, RECHECK_MISSING_DAYS, limit])).rows;
  const rep: LookupReport = { candidates: cand.length, checked: 0, found: 0, outOfTime: false, failed: 0, failStatus: null };
  for (const [i, { p9 }] of cand.entries()) {
    // Стеля перевіряється ПІСЛЯ першого номера: хоч один запит прохід робить завжди, інакше нульовий бюджет мовчки
    // перетворив би джобу на «успіх» без жодного запиту.
    if (i > 0 && Date.now() - started >= budgetMs) { rep.outOfTime = true; break; }
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const res = await search(p9);
    const row = lookupRow(res);
    if (!row) { rep.failed = 1; rep.failStatus = res.status; break; }
    await db.query(LOOKUP_UPSERT_SQL, [p9, row.users, row.name]);
    rep.checked++;
    if (isLardiCarrier(row.users)) rep.found++;
  }
  if (rep.checked === 0 && rep.failed > 0) throw new Error(`Ларді не відповів на пошук номера (статус ${String(rep.failStatus)}) — номери пропущених не перевірено`);
  // Знайдені мусять дійти до екрана зараз, а не о :22. Збій перебудови — помилка джоби (не ковтаємо): записані номери
  // нікуди не діваються, їх підбере наступна перебудова.
  if (rep.found > 0 && o.onFound) await o.onFound();
  return rep;
}
