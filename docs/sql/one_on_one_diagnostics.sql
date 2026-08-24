-- ═══════════════════════════════════════════════════════════════════════════
-- ДІАГНОСТИКА ФІЧІ «ВАН-ТУ-ВАН» (1×1) · READ-ONLY · Neon SQL Editor
-- Складено 24.08.2026 за наслідками аналізу коду (S2/S3/S4/S5).
--
-- 🔒 УСІ ЗАПИТИ — ЛИШЕ `SELECT`. Жодного INSERT/UPDATE/DELETE/DDL. Прогін
--    безпечний на бойовій базі; блокувань не бере, індексів не створює.
--
-- 🔴 ЯК ЧИТАТИ РЕЗУЛЬТАТ. Порожня видача сама по собі НЕ є доброю новиною —
--    вона означає «не знайшлось» лише тоді, коли доведено, що БУЛО де шукати.
--    Тому Q0 прогонити ПЕРШИМ і завжди: він показує, скільки взагалі є даних.
--    Якщо Q0 дав 0 зустрічей — решта запитів порожні за побудовою, і жоден
--    висновок «усе гаразд» із них не випливає.
--
-- ⚠️ У промті просили порівняти `updated_at ≫ created_at`. Колонки `created_at`
--    у `one_on_ones` НЕМАЄ (перевірено: backend/src/db/schema.sql:954-982 — там
--    лише `updated_at`). Тому вік правки рахуємо від ДАТИ ЗУСТРІЧІ (Q2b), а
--    факт переписаної привʼязки до форми доводимо окремо й строго (Q2a).
--
-- ⚠️ Оператор `?` (jsonb-has-key) свідомо НЕ вживається — деякі клієнти
--    читають його як плейсхолдер параметра. Скрізь `jsonb_exists()`.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- Q0 · БАЗА. Скільки взагалі є зустрічей — контроль «було де шукати».
--   meetings        — усі записи типу
--   with_answers    — з непорожньою анкетою (саме вони й є проведені зустрічі)
--   empty_answers   — анкета порожня (кандидати в «кістяки», деталі в Q4)
--   last_6m         — за останні 6 місяців
--   subjects        — скільки різних людей; conductors — скільки різних ведучих
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  o.type,
  count(*)                                                          AS meetings,
  count(*) FILTER (WHERE o.answers IS NOT NULL AND o.answers <> '{}'::jsonb) AS with_answers,
  count(*) FILTER (WHERE o.answers IS NULL OR o.answers = '{}'::jsonb)       AS empty_answers,
  count(*) FILTER (WHERE o.meeting_date >= (current_date - INTERVAL '6 months')) AS last_6m,
  count(DISTINCT o.subject_manager_id)                              AS subjects,
  count(DISTINCT o.conducted_by)                                    AS conductors,
  min(o.meeting_date)                                               AS first_meeting,
  max(o.meeting_date)                                               AS last_meeting
FROM one_on_ones o
GROUP BY ROLLUP (o.type)
ORDER BY o.type NULLS LAST;


-- ───────────────────────────────────────────────────────────────────────────
-- Q0b · ФОРМИ. Скільки версій у кожного типу, яка активна, коли створена.
-- Потрібно, щоб читати Q1/Q2: якщо версія одна на тип — переписати привʼязку
-- нема на що, і порожній Q2a означає саме це, а не «історія ціла».
-- ───────────────────────────────────────────────────────────────────────────
SELECT f.type,
       count(*)                                            AS versions,
       max(f.version) FILTER (WHERE f.is_active)           AS active_version,
       max(f.created_at) FILTER (WHERE f.is_active)        AS active_created_at,
       min(f.created_at)                                   AS first_created_at
FROM one_on_one_forms f
GROUP BY f.type
ORDER BY f.type;


-- ───────────────────────────────────────────────────────────────────────────
-- Q1 · S2 — ЗАГАЛЬНА ОЦІНКА РОЗХОДИТЬСЯ З ТИМ, ЩО ПОКАЗУЄ ЕКРАН.
--
-- Сервер рахує `overall` як середнє ПО ВСІХ відповідях, де є `score`
-- (backend/src/routes/oneOnOnes.ts:51). Екран проведення рахує середнє лише по
-- score-питаннях АКТИВНОЇ форми (frontend/.../OneOnOneSection.tsx:231). Цей
-- запит рахує другим правилом і показує записи, де два числа не збігаються.
--
-- Кожен рядок = зустріч, де кільце на екрані показувало б НЕ те, що лежить у базі
-- (і що потім малює вкладка «Історія»).
--   overall_db      — те, що збережено
--   overall_by_form — те саме за правилом екрана (активна форма)
--   scored_db / scored_form — скільки балів увійшло в кожне
-- ───────────────────────────────────────────────────────────────────────────
WITH active AS (
  SELECT f.type,
         f.version,
         ARRAY(SELECT q->>'qKey'
                 FROM jsonb_array_elements(f.questions->'sections') AS s,
                      jsonb_array_elements(s->'questions')          AS q
                WHERE q->>'field' IN ('score','score_text')) AS score_keys
    FROM one_on_one_forms f
   WHERE f.is_active
),
by_form AS (
  SELECT o.subject_manager_id, o.type, o.meeting_date,
         round(avg(x.score), 1) AS overall_by_form,
         count(x.score)         AS scored_form
    FROM one_on_ones o
    JOIN active a ON a.type = o.type
    LEFT JOIN LATERAL (
      SELECT (o.answers -> k ->> 'score')::numeric AS score
        FROM unnest(a.score_keys) AS k
       WHERE (o.answers -> k ->> 'score') ~ '^[0-9]+(\.[0-9]+)?$'
         AND (o.answers -> k ->> 'score')::numeric > 0
    ) x ON TRUE
   WHERE o.type IN ('A','B')
   GROUP BY o.subject_manager_id, o.type, o.meeting_date
),
by_answers AS (
  SELECT o.subject_manager_id, o.type, o.meeting_date,
         count(y.score) AS scored_db
    FROM one_on_ones o
    LEFT JOIN LATERAL (
      SELECT (e.value ->> 'score')::numeric AS score
        FROM jsonb_each(o.answers) AS e(key, value)
       WHERE jsonb_typeof(e.value) = 'object'
         AND (e.value ->> 'score') ~ '^[0-9]+(\.[0-9]+)?$'
         AND (e.value ->> 'score')::numeric > 0
    ) y ON TRUE
   WHERE o.type IN ('A','B')
   GROUP BY o.subject_manager_id, o.type, o.meeting_date
)
SELECT m.name              AS subject,
       o.type,
       o.meeting_date,
       o.overall           AS overall_db,
       b.overall_by_form,
       a.scored_db,
       b.scored_form,
       o.form_version,
       o.updated_at
  FROM one_on_ones o
  JOIN by_form    b ON (b.subject_manager_id, b.type, b.meeting_date) = (o.subject_manager_id, o.type, o.meeting_date)
  JOIN by_answers a ON (a.subject_manager_id, a.type, a.meeting_date) = (o.subject_manager_id, o.type, o.meeting_date)
  JOIN managers   m ON m.id = o.subject_manager_id
 WHERE o.type IN ('A','B')
   AND o.overall IS DISTINCT FROM b.overall_by_form
 ORDER BY o.meeting_date DESC, m.name;


-- ───────────────────────────────────────────────────────────────────────────
-- Q1b · S2 — МЕХАНІЗМ РОЗХОДЖЕННЯ: «осиротілі бали».
-- Бали, що лежать в анкеті під ключами, яких в АКТИВНІЙ формі вже немає
-- (питання прибрали або перевели в «Текст»). Саме вони й тягнуть серверне
-- середнє вбік від екранного. Порожньо тут + порожньо в Q1 = розходження ще
-- не настало; непорожньо тут при порожньому Q1 — числа поки збігаються
-- випадково (середнє не зрушило), але механізм уже працює.
-- ───────────────────────────────────────────────────────────────────────────
WITH active AS (
  SELECT f.type,
         ARRAY(SELECT q->>'qKey'
                 FROM jsonb_array_elements(f.questions->'sections') AS s,
                      jsonb_array_elements(s->'questions')          AS q
                WHERE q->>'field' IN ('score','score_text')) AS score_keys
    FROM one_on_one_forms f
   WHERE f.is_active
)
SELECT o.type,
       count(*)      AS records_with_orphans,
       sum(c.cnt)    AS orphan_scores_total,
       min(o.meeting_date) AS first_meeting,
       max(o.meeting_date) AS last_meeting,
       (array_agg(DISTINCT c.keys))[1:5] AS sample_keys
  FROM one_on_ones o
  JOIN active a ON a.type = o.type
  CROSS JOIN LATERAL (
    SELECT count(*) AS cnt, string_agg(e.key, ',') AS keys
      FROM jsonb_each(o.answers) AS e(key, value)
     WHERE jsonb_typeof(e.value) = 'object'
       AND jsonb_exists(e.value, 'score')
       AND NOT (e.key = ANY(a.score_keys))
  ) c
 WHERE o.type IN ('A','B') AND c.cnt > 0
 GROUP BY o.type;


-- ───────────────────────────────────────────────────────────────────────────
-- Q2a · S3 — ЗАПИС ПРИВʼЯЗАНИЙ ДО ФОРМИ, ЯКОЇ НА ДАТУ ЗУСТРІЧІ ЩЕ НЕ БУЛО.
-- `POST /record` завжди ставить АКТИВНУ на момент збереження версію
-- (oneOnOnes.ts:248,256), тож така пара «дата зустрічі / вік форми» означає, що
-- анкету зберігали вже ПІСЛЯ зміни набору питань.
--
-- 🔴 ЧЕСНА МЕЖА, ЯКУ ТРЕБА ЗНАТИ ДО ЧИТАННЯ ВИДАЧІ: відрізнити «правку старого
--    запису» від «внесення зустрічі заднім числом» цим запитом НЕМОЖЛИВО — обидва
--    дають той самий слід, бо колонки `created_at` у `one_on_ones` немає. Тому
--    висновок робить людина, дивлячись на `verdict` + `days_after_meeting` (Q2b).
--    Саме через цю сліпоту в меню покращень стоїть П3 (не переписувати
--    form_version на правці) і П10 (журнал змін).
--
-- `verdict` розрізняє те, що РОЗРІЗНИТИ МОЖНА:
--   • «через застосунок так не буває» — форма створена ПІЗНІШЕ за останній запис
--     рядка, тобто версію проставив не роут; дивитись у бік ручних правок у БД;
--   • «зберігали після зустрічі» — правка історії АБО пізніше внесення.
SELECT m.name AS subject,
       o.type,
       o.meeting_date,
       o.form_version,
       f.created_at        AS form_created_at,
       o.updated_at,
       (o.updated_at::date - o.meeting_date) AS days_after_meeting,
       CASE
         WHEN f.created_at > o.updated_at
           THEN 'через застосунок так не буває — версія новіша за останній запис рядка'
         WHEN o.updated_at::date > o.meeting_date
           THEN 'зберігали після зустрічі: правка історії АБО внесення заднім числом'
         ELSE 'інше — розібрати вручну'
       END AS verdict
  FROM one_on_ones o
  JOIN one_on_one_forms f ON f.type = o.type AND f.version = o.form_version
  JOIN managers m         ON m.id = o.subject_manager_id
 WHERE f.created_at::date > o.meeting_date
 ORDER BY o.meeting_date DESC;


-- Q2b · S3 — ПРАВКИ ЗАДНІМ ЧИСЛОМ: збережено набагато пізніше зустрічі.
-- Не є доказом поломки саме по собі (зустріч могли дозаповнити наступного
-- дня), тому поріг явний — БІЛЬШЕ 7 днів. Читати разом із Q2a: рядок, що є в
-- обох, — це вже точно правка старого запису, а не запізніле заповнення.
-- ───────────────────────────────────────────────────────────────────────────
SELECT m.name AS subject,
       o.type,
       o.meeting_date,
       o.updated_at,
       (o.updated_at::date - o.meeting_date) AS days_after_meeting,
       o.form_version,
       COALESCE(cm.name, u.email) AS conducted_by_name
  FROM one_on_ones o
  JOIN managers m  ON m.id = o.subject_manager_id
  LEFT JOIN users u    ON u.id = o.conducted_by
  LEFT JOIN managers cm ON cm.id = u.manager_id
 WHERE (o.updated_at::date - o.meeting_date) > 7
 ORDER BY (o.updated_at::date - o.meeting_date) DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- Q2c · S3 — АВТОРСТВО МОГЛО БУТИ ПІДМІНЕНЕ. `POST /record` пише
-- `conducted_by = EXCLUDED.conducted_by` (oneOnOnes.ts:254), тож наскрізний
-- (HR/СЕО/ОД), який відкрив і зберіг чужу зустріч, стає її «ведучим».
-- Тип A проводить ТІЛЬКИ тімлід — отже запис типу A, автор якого має
-- наскрізне право, майже напевно перезбережений, а не проведений ним.
-- ⚠️ Це ОЗНАКА, не вирок: наскрізний має право провести A і сам.
-- ───────────────────────────────────────────────────────────────────────────
SELECT m.name AS subject,
       o.type,
       o.meeting_date,
       o.updated_at,
       u.email                       AS conducted_by_email,
       COALESCE(u.role_override, u.role) AS conductor_role_key,
       COALESCE(cm.name, '—')        AS conductor_name,
       cm.is_team_lead               AS conductor_is_team_lead
  FROM one_on_ones o
  JOIN managers m ON m.id = o.subject_manager_id
  JOIN users u    ON u.id = o.conducted_by
  JOIN roles r    ON r.key = COALESCE(u.role_override, u.role)
  LEFT JOIN managers cm ON cm.id = u.manager_id
 WHERE o.type = 'A'
   AND jsonb_extract_path_text(r.permissions, 'view_all_1x1') = 'true'
 ORDER BY o.meeting_date DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- Q3 · S4 — ЗНАЧЕННЯ ПОЗА ДОЗВОЛЕНИМИ МЕЖАМИ.
-- `enpsScore` приймається без перевірки діапазону (oneOnOnes.ts:238), тоді як
-- сусідній `satisfaction` перевіряється на 1..10 (:244-246). Наслідок бала
-- поза шкалою: він стає `overall` типу В і псує агрегат `/enps` — потрапляє в
-- `total`, не будучи ні промоутером, ні критиком, тобто ЗАНИЖУЄ eNPS мовчки.
-- Одна видача, чотири різні порушення — колонка `issue` каже, яке саме.
-- ───────────────────────────────────────────────────────────────────────────
SELECT 'enps поза 0..10'              AS issue, o.type, m.name AS subject, o.meeting_date,
       o.enps_score AS value, o.satisfaction_score, o.overall
  FROM one_on_ones o JOIN managers m ON m.id = o.subject_manager_id
 WHERE o.enps_score IS NOT NULL AND (o.enps_score < 0 OR o.enps_score > 10)
UNION ALL
SELECT 'enps у типі, де його немає',  o.type, m.name, o.meeting_date,
       o.enps_score, o.satisfaction_score, o.overall
  FROM one_on_ones o JOIN managers m ON m.id = o.subject_manager_id
 WHERE o.enps_score IS NOT NULL AND o.type <> 'V'
UNION ALL
SELECT 'satisfaction поза 1..10',     o.type, m.name, o.meeting_date,
       o.satisfaction_score, o.satisfaction_score, o.overall
  FROM one_on_ones o JOIN managers m ON m.id = o.subject_manager_id
 WHERE o.satisfaction_score IS NOT NULL AND (o.satisfaction_score < 1 OR o.satisfaction_score > 10)
UNION ALL
-- Для типу В задоволеність ЗА ВИЗНАЧЕННЯМ дорівнює eNPS-балу (oneOnOnes.ts:244).
-- Розбіжність означала б, що запис писали двома різними шляхами.
SELECT 'тип В: satisfaction <> enps', o.type, m.name, o.meeting_date,
       o.enps_score, o.satisfaction_score, o.overall
  FROM one_on_ones o JOIN managers m ON m.id = o.subject_manager_id
 WHERE o.type = 'V' AND o.satisfaction_score IS DISTINCT FROM o.enps_score
ORDER BY 1, 4 DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- Q4 · S5 — «КІСТЯКИ»: рядок зустрічі, створений рев'ю задачі, без анкети.
-- `POST /task/:id/review` створює запис `one_on_ones` з самим `task_reviews`
-- (oneOnOnes.ts:346-352), а `/subjects` рахує БУДЬ-ЯКІ рядки (:141,146) — тож
-- для такої дати екран малює зелену крапку «проведено».
-- Кожен рядок видачі = дата, на яку 1×1 показано проведеним, а анкети немає.
-- ───────────────────────────────────────────────────────────────────────────
SELECT m.name AS subject,
       o.type,
       o.meeting_date,
       jsonb_array_length(COALESCE(o.task_reviews, '[]'::jsonb)) AS task_reviews,
       o.updated_at,
       COALESCE(cm.name, u.email) AS created_by_review
  FROM one_on_ones o
  JOIN managers m ON m.id = o.subject_manager_id
  LEFT JOIN users u     ON u.id = o.conducted_by
  LEFT JOIN managers cm ON cm.id = u.manager_id
 WHERE o.task_reviews IS NOT NULL
   AND jsonb_array_length(o.task_reviews) > 0
   AND (o.answers IS NULL OR o.answers = '{}'::jsonb)
   AND o.overall IS NULL
   AND o.enps_score IS NULL
 ORDER BY o.meeting_date DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- Q4b · S5 — той самий зріз ЧИСЛОМ, по типах, + скільки з них припадає на
-- ПОТОЧНИЙ місяць (саме ці зараз світять зеленою крапкою на екрані).
-- ───────────────────────────────────────────────────────────────────────────
SELECT o.type,
       count(*) AS skeletons,
       count(*) FILTER (WHERE date_trunc('month', o.meeting_date) = date_trunc('month', current_date)) AS in_current_month,
       min(o.meeting_date) AS first_seen,
       max(o.meeting_date) AS last_seen
  FROM one_on_ones o
 WHERE o.task_reviews IS NOT NULL
   AND jsonb_array_length(o.task_reviews) > 0
   AND (o.answers IS NULL OR o.answers = '{}'::jsonb)
   AND o.overall IS NULL
   AND o.enps_score IS NULL
 GROUP BY o.type
 ORDER BY o.type;
