/**
 * 🎯 «ПЕРШИЙ ДОТИК» — ЦІНУ НАЗВАНО В ПЕРШІЙ РОЗМОВІ (ТЗ-3 §3.2, 17.09.2026). ЧИСТИЙ МОДУЛЬ.
 *
 * Джерело — оцінка uts-bot (Whisper + LLM) першого вхідного дзвінка по рекламному ліду, що
 * лягає в Google-лист і синкається в `first_touch_analysis` (`jobs/syncFirstTouch.ts`).
 *
 * Рішення власника 17.09.2026, не перевідкривати:
 *  · ДОТИК НАЛЕЖИТЬ ТОМУ, ХТО ДЗВОНИВ (`manager_name` з листа), а не поточному відповідальному
 *    угоди: показник оцінює розмову, а розмову вів той, хто говорив. За 60 днів до 16.09 угоду
 *    потім передали іншому в 12 із 392 оцінок (3 %);
 *  · ЧЕСНІ СТАНИ: менеджер команди, яку бот не оцінює взагалі, — «не вимірюється», а не 0 з 0;
 *    рядок «немає запису» — окремим числом і ПОЗА відсотком (бот пише його як «ціну не названо»,
 *    хоча розмови не чув);
 *  · доступ — як у решти Звіту (менеджер бачить картки своєї команди).
 * Рекламного предиката дашборд не додає — це РІШЕННЯ 8 у ТЗ, окремо; бот фільтрує сам.
 *
 * ⚠️ ЗВʼЯЗКА ПО ІМЕНІ, БО ІНШОЇ НЕМАЄ: у листі лише ПІБ. Ключ — прізвище + імʼя в нижньому
 * регістрі без апострофів (у листі «Безпам'ятний» з ', у CRM трапляється ʼ і без апострофа).
 * Заміряно 16.09: 392 з 392 оцінок за 60 днів звʼязались. Що не звʼязалось — не зникає, а
 * їде другим числом «не прив'язано до менеджера».
 */

/** Позначка бота «розмови не чули» — саме так, як її пише `sheets.py`. */
export const FT_NO_RECORD = "немає запису";

/** Ключ імені для звʼязки: «Прізвище Імʼя», нижній регістр, без апострофів і зайвих пробілів. */
export function ftNameKey(name: string | null | undefined): string {
  const words = String(name ?? "").replace(/['ʼ’`]/g, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(" ");
}

/** Той самий ключ у SQL — один вираз на обидва боки звʼязки. `#467` звіряє його з JS. */
export const ftNameKeySql = (expr: string): string =>
  `lower(array_to_string((regexp_split_to_array(regexp_replace(regexp_replace(coalesce(${expr}, ''), '[''ʼ’\`]', '', 'g'), '^\\s+|\\s+$', '', 'g'), '\\s+'))[1:2], ' '))`;

const noRecordSql = (a: string): string => `(lower(btrim(coalesce(${a}.about_transport, ''))) = '${FT_NO_RECORD}')`;

/**
 * Мапа «ключ імені → менеджер»: регулярка рахується ОДИН раз на менеджера, а не на кожну пару
 * «оцінка × менеджер» (так було в першій редакції: 585 мс на 90 днів проти десятків після).
 * Серед однойменних — активний, потім найновіший (дублі користувачів Kommo — борг зони Звіту).
 */
const managerKeysCte = (): string => `
    mk AS (
      SELECT DISTINCT ON (k.key) k.key, k.id, k.team_id
        FROM (SELECT mm.id, mm.team_id, mm.is_active, ${ftNameKeySql("mm.name")} AS key FROM managers mm) k
       WHERE k.key <> ''
       ORDER BY k.key, k.is_active DESC, k.id DESC
    )`;

/** Оцінки за період, згруповані за менеджером, який ДЗВОНИВ. `manager_id IS NULL` — не звʼязалось. */
export function firstTouchByCallerSql(from: string, to: string): { sql: string; params: unknown[] } {
  const sql = `
    WITH ${managerKeysCte()},
    f AS (
      SELECT fta.price_voiced, ${noRecordSql("fta")} AS no_record, mk.id AS manager_id
        FROM first_touch_analysis fta
        LEFT JOIN mk ON mk.key = ${ftNameKeySql("fta.manager_name")}
       WHERE fta.analyzed_at BETWEEN $1::date AND $2::date
    )
    SELECT manager_id,
           COUNT(*) FILTER (WHERE NOT no_record)::int AS analyzed,
           COUNT(*) FILTER (WHERE NOT no_record AND price_voiced)::int AS voiced,
           COUNT(*) FILTER (WHERE no_record)::int AS no_record
      FROM f
     GROUP BY manager_id`;
  return { sql, params: [from, to] };
}

/**
 * Які команди бот оцінює ВЗАГАЛІ (за всю історію таблиці, за поточною командою звʼязаного
 * менеджера) і коли прийшла остання оцінка. Від періоду не залежить свідомо: «бот мовчить цього
 * тижня» і «бот цю команду не слухає» — різні відповіді, і перша не має ставати другою.
 */
export const firstTouchMetaSql = (): string => `
  WITH ${managerKeysCte()}
  SELECT COALESCE(array_agg(DISTINCT mk.team_id) FILTER (WHERE mk.team_id IS NOT NULL), '{}') AS covered_team_ids,
         to_char(MAX(fta.analyzed_at), 'YYYY-MM-DD') AS last_analyzed_at
    FROM first_touch_analysis fta
    LEFT JOIN mk ON mk.key = ${ftNameKeySql("fta.manager_name")}`;

export interface FirstTouchCounts { analyzed: number; voiced: number; noRecord: number }
export type FirstTouchState = "measured" | "not_covered";
export interface FirstTouchCell extends FirstTouchCounts { state: FirstTouchState }

/** Клітинка менеджера: чесний стан і лічильники. Непокрита команда — лічильники нульові й не показуються. */
export function firstTouchCell(counts: FirstTouchCounts | undefined, teamId: number | null, coveredTeamIds: ReadonlySet<number>): FirstTouchCell {
  const covered = teamId != null && coveredTeamIds.has(teamId);
  // Якщо оцінки є, а команда «не покрита» (людина щойно змінила команду) — рахуємо як виміряне:
  // ховати наявні оцінки гірше, ніж показати їх у новій команді.
  const has = (counts?.analyzed ?? 0) + (counts?.noRecord ?? 0) > 0;
  return {
    state: covered || has ? "measured" : "not_covered",
    analyzed: counts?.analyzed ?? 0, voiced: counts?.voiced ?? 0, noRecord: counts?.noRecord ?? 0,
  };
}

/** Відсоток «ціну названо» — від ОЦІНЕНИХ розмов; «немає запису» у знаменник не входить. `null` = нема з чого рахувати. */
export const firstTouchPct = (voiced: number, analyzed: number): number | null =>
  analyzed > 0 ? Math.round((voiced / analyzed) * 1000) / 10 : null;

/** Σ клітинок — підсумок команди. Відсоток ПОТІМ, із сум, а не середнім відсотків. */
export function sumFirstTouch(cells: FirstTouchCounts[]): FirstTouchCounts {
  return cells.reduce((s, c) => ({ analyzed: s.analyzed + c.analyzed, voiced: s.voiced + c.voiced, noRecord: s.noRecord + c.noRecord }),
    { analyzed: 0, voiced: 0, noRecord: 0 });
}
