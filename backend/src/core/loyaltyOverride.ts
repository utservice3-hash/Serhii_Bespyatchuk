/**
 * 🔧 РУЧНА ПРАВКА ПОСТІЙНОГО КЛІЄНТА — побудова UPSERT-у в `loyalty_overrides`.
 *
 * 🔴 НАВІЩО ОКРЕМА ФУНКЦІЯ, А НЕ SQL У РОУТІ. Тут живе рівно одне правило, і воно
 * НЕ видно з форми запиту: оновлюються ЛИШЕ передані поля. Було інакше — відсутнє
 * в тілі поле їхало в UPDATE як `NULL`/`false`. Тобто запит «прибрати з постійних»
 * (`{clientKey, hidden}`) ТИХО знімав би `pinned_manager_id` — того самого
 * «відповідального біля клієнта», якого 04.08.2026 оголошено ЄДИНИМ джерелом для
 * трьох екранів і форми передачі. Формула `COALESCE(закріплений, основний)`
 * мовчки віддала б другу гілку, і жоден екран не сказав би, коли саме зникла
 * перша: клієнт просто «раптом» опинився б в іншого менеджера.
 *
 * 🔴 КЛЮЧ — «поля НЕ БУЛО В ТІЛІ», а не «значення порожнє». `pinnedManagerId: null`
 * лишається ЯВНИМ «зняти закріплення»: якби ми не розрізняли ці два випадки,
 * зняти закріплення стало б неможливо взагалі, і ми полагодили б одну діру,
 * викопавши другу.
 *
 * Винесено сюди саме для того, щоб це можна було ДОВЕСТИ на справжньому SQL проти
 * бази (тест #32), а не переказати коментарем у роуті.
 */

export interface OverrideBody {
  clientKey?: unknown; clientName?: unknown;
  pinnedManagerId?: unknown; forceRegular?: unknown; note?: unknown;
}

export interface OverrideUpsert { sql: string; params: unknown[] }

/**
 * `$3`/`$5` (hidden/forceRegular) — `null` означає «не передали» → COALESCE лишає
 * поточне. `$8`/`$9` — прапорці «поле БУЛО в тілі» для pinned/note, бо для них
 * `null` є легальним ЗНАЧЕННЯМ і COALESCE тут не годиться.
 */
export function buildOverrideUpsert(body: OverrideBody, userId: number | null): OverrideUpsert {
  const has = (k: keyof OverrideBody) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const clientKey = String(body?.clientKey ?? "").trim();
  const clientName = body?.clientName != null ? String(body.clientName) : null;
  // 🗄 `hidden` БІЛЬШЕ НЕ ПИШЕТЬСЯ (хвиля 2, 05.08.2026). Прибрати клієнта з
  // екранів тепер уміє РІВНО ОДНА дія — `/client-archive` (дата + причина + хто).
  // Лишити тут запис означало б завести ТИХИЙ NO-OP: поле писалось би, а жоден
  // запит його вже не читає — і «кнопка не спрацювала» повернулось би, тільки
  // цього разу без сліду в коді. Стовпець у БД лишається як історичний слід.
  const forceRegular = has("forceRegular") ? body.forceRegular === true : null;
  const pinnedProvided = has("pinnedManagerId");
  // Порожній рядок із <select> читаємо як явний null — це «— не обрано —».
  const pinnedManagerId = pinnedProvided && body.pinnedManagerId != null && body.pinnedManagerId !== ""
    ? Number(body.pinnedManagerId) : null;
  const noteProvided = has("note");
  const note = noteProvided && body.note != null ? String(body.note) : null;

  return {
    // ⚠️ Параметр під `hidden` ПРИБРАНО ЗОВСІМ, а не лишений порожнім: невживаний
    // `$3` дає «could not determine data type of parameter $3» — Postgres не вміє
    // вивести тип для плейсхолдера, якого немає в тексті. Спіймав гейт #32.
    sql: `INSERT INTO loyalty_overrides (client_key, client_name, pinned_manager_id, force_regular, note, updated_by, updated_at)
     VALUES ($1, $2, $3::int, COALESCE($4::boolean, false), $5::text, $6, now())
     ON CONFLICT (client_key) DO UPDATE SET
       client_name       = COALESCE(EXCLUDED.client_name, loyalty_overrides.client_name),
       force_regular     = COALESCE($4::boolean, loyalty_overrides.force_regular),
       pinned_manager_id = CASE WHEN $7::boolean THEN $3::int ELSE loyalty_overrides.pinned_manager_id END,
       note              = CASE WHEN $8::boolean THEN $5::text ELSE loyalty_overrides.note END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    params: [clientKey, clientName, pinnedManagerId, forceRegular, note, userId,
             pinnedProvided, noteProvided],
  };
}
