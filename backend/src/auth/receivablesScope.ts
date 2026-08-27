import type { AuthPayload } from "./auth.js";

/**
 * 🔒 СКОУП ДЕБІТОРКИ — ОДИН ВИРАЗ НА ВСІ ДВЕРІ ТІЄЇ САМОЇ ВКЛАДКИ.
 *
 * 🔴 ЧОМУ ЦЕЙ ФАЙЛ ЗʼЯВИВСЯ. `GET /receivables` звужував бездоганно — заміряно
 * ворожою пробою 26.08.2026: менеджер 12 клієнтів (1 менеджер у відповіді),
 * тімлід 5 (2 менеджери його команди), адмін 78 (23); `?teamId=5` і
 * `?managerId=81` менеджера не розширюють, `?managerId=4` тімліду з ЧУЖОЇ
 * команди дає нуль. А сусідні двері тієї самої вкладки —
 * `/receivables/writeoffs` і `/receivables/note-history` — не звужували
 * НІЧОГО: менеджер отримував байт-у-байт ту саму відповідь, що адмін, тобто
 * усі 8 списань на 68 178 ₴ із приписками «хто кому й скільки простив» і
 * коментарі тімлідів про будь-якого клієнта.
 *
 * Правило було правильне й записане РІВНО В ОДНОМУ обробнику. Поки воно живе
 * всередині роута, наступні двері відчиняються без нього — і це не недбалість,
 * а властивість: копіювати нема чого, бо копіювати нічого й не видно.
 *
 * 🔴 FAIL-CLOSED, А НЕ «У НАС ТАКИХ НЕМАЄ». `debtWhere` додає умову лише при
 * ІСТИННОМУ значенні, тож менеджер із `managerId = null` дав би ПОРОЖНІЙ
 * `WHERE`, тобто всю дебіторку компанії. Заміряно: таких користувачів нуль,
 * тімлідів без `team_id` теж нуль — але тримається це на ДАНИХ, а не на КОДІ.
 *
 * ⚠️ Функція НЕ ходить у БД і нічого не фільтрує сама: вона лише каже, ЯКИЙ
 * скоуп законний. Фільтрує далі `metrics.receivablesByClient` — та сама
 * функція, що будує список. Другий вираз для «які клієнти мої» розійшовся б
 * зі списком тихо, і саме тому його тут немає.
 */
export type ReceivablesScope =
  | { ok: true; managerId: number | null; teamId: number | null }
  | { ok: false; status: 403; error: string };

export function receivablesScope(
  auth: Pick<AuthPayload, "role" | "managerId" | "teamId">,
  query: { managerId?: unknown; teamId?: unknown } = {},
): ReceivablesScope {
  if (auth.role === "manager") {
    if (auth.managerId == null) {
      return { ok: false, status: 403, error: "Обліковий запис не звʼязаний із менеджером — показувати нічого" };
    }
    // Параметри рядка запиту ПЕРЕЗАПИСУЮТЬСЯ, а не доповнюються: інакше
    // `?teamId=` розширив би видимість замість звузити.
    return { ok: true, managerId: auth.managerId, teamId: null };
  }
  if (auth.role === "team_lead") {
    if (auth.teamId == null) {
      return { ok: false, status: 403, error: "Тімлід без команди — скоуп невизначений" };
    }
    // Тімлід МОЖЕ звузитись до одного зі своїх — `debtWhere` зʼєднує умови
    // через `AND`, тож менеджер із чужої команди дає порожній результат, а не
    // доступ. Доведено пробою, не читанням.
    const m = query.managerId != null && query.managerId !== "" ? Number(query.managerId) : null;
    return { ok: true, managerId: Number.isFinite(m as number) ? (m as number) : null, teamId: auth.teamId };
  }
  const m = query.managerId != null && query.managerId !== "" ? Number(query.managerId) : null;
  const t = query.teamId != null && query.teamId !== "" ? Number(query.teamId) : null;
  return {
    ok: true,
    managerId: Number.isFinite(m as number) ? (m as number) : null,
    teamId: Number.isFinite(t as number) ? (t as number) : null,
  };
}
