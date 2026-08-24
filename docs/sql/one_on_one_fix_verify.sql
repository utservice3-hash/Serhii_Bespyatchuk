-- ═══════════════════════════════════════════════════════════════════════════
-- ВИПРАВЛЕННЯ ДАНИХ 1×1 · VERIFY-SQL ДЛЯ ВЛАСНИКА · Neon SQL Editor
-- Складено 24.08.2026. Виконує ВЛАСНИК; асистент нічого з цього не запускав.
--
-- 🔴 ПОРЯДОК ЖОРСТКИЙ: спершу SELECT — подивитись, що саме зачепить; аж тоді дія.
--    Кожна дія обмежена запобіжником: якщо зачепило НЕ стільки рядків, скільки
--    показав SELECT, транзакція падає і НЕ змінює нічого. Це не ввічливість —
--    `DELETE` без такого запобіжника мовчки виносить зайве, і дізнаємось ми про це
--    з екрана через тиждень.
--
-- 🔴 ЩО ТУТ СВІДОМО ВІДСУТНЄ: hard-delete менеджера «наосліп». Причина — у ЧАСТИНІ 2,
--    і вона не про обережність, а про механіку: syncKommo кожні 30 хв відновлює
--    рядок і ЗАТИРАЄ ручну деактивацію (jobs/syncKommo.ts:138-148, 162-167).
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ ЧАСТИНА 1 · ТЕСТОВА ОЦІНКА ВОРОШИЛОВОЇ ВІКТОРІЇ (01.07) — ВИДАЛИТИ ОДИН   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ───────────────────────────────────────────────────────────────────────────
-- A1.1 · ЩО САМЕ Є. Пошук за частиною прізвища — щоб не спіткнутись об по батькові
-- чи інший регістр. Дивитись треба на ТРИ колонки, бо ключ запису — саме вони:
-- (subject_manager_id, type, meeting_date). «Оцінка від 01.07» — це ОДИН рядок із
-- цієї видачі; його три значення підставите нижче.
-- ⚠️ Якщо рядків за 01.07 більше одного (різні типи A/Б/В) — це РІЗНІ зустрічі.
-- ───────────────────────────────────────────────────────────────────────────
SELECT o.subject_manager_id,
       m.name                       AS subject,
       o.type,
       o.meeting_date,
       o.overall,
       o.enps_score,
       o.satisfaction_score,
       (o.answers IS NOT NULL AND o.answers <> '{}'::jsonb) AS has_answers,
       jsonb_array_length(COALESCE(o.task_reviews,'[]'::jsonb)) AS task_reviews,
       o.form_version,
       o.updated_at,
       COALESCE(cm.name, u.email)   AS conducted_by
  FROM one_on_ones o
  JOIN managers m       ON m.id = o.subject_manager_id
  LEFT JOIN users u     ON u.id = o.conducted_by
  LEFT JOIN managers cm ON cm.id = u.manager_id
 WHERE m.name ILIKE '%орошилов%'
 ORDER BY o.meeting_date DESC, o.type;


-- ───────────────────────────────────────────────────────────────────────────
-- A1.2 · ЩО ЛИШИТЬСЯ ПІСЛЯ ВИДАЛЕННЯ. Задачі з 1×1 посилаються на зустріч
-- ПОЛЯМИ (`o2o_type`, `o2o_meeting_date`), а не зовнішнім ключем — тобто база
-- видалити зустріч дозволить, а задачі спокійно лишаться вказувати на дату, якої
-- більше немає. Для тестового запису це нормально (задач там зазвичай нема), але
-- подивитись треба ДО, а не дивуватись ПІСЛЯ.
-- Порожня видача = чисто, задач на цю зустріч не ставили.
-- ───────────────────────────────────────────────────────────────────────────
SELECT t.id, t.title, t.status, t.o2o_type, t.o2o_meeting_date, t.o2o_resolution,
       t.assignee_id, m.name AS assignee
  FROM tasks t
  JOIN managers m ON m.id = t.assignee_id
 WHERE t.task_type = 'oneonone'
   AND m.name ILIKE '%орошилов%'
 ORDER BY t.o2o_meeting_date DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- A1.3 · ВИДАЛЕННЯ РІВНО ОДНОГО РЯДКА.
-- ⚠️ ПІДСТАВИТИ три значення з A1.1 у перші три рядки блоку. Нічого більше
--    міняти не треба.
-- Запобіжник: якщо під умову підпаде не рівно 1 рядок — `RAISE EXCEPTION`
-- відкочує транзакцію, і в базі не змінюється НІЧОГО.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_subject_id  int  := 0;              -- ← subject_manager_id з A1.1
  v_type        text := 'V';            -- ← type з A1.1 ('A' | 'B' | 'V')
  v_date        date := DATE '2026-07-01';  -- ← meeting_date з A1.1
  n int;
BEGIN
  DELETE FROM one_on_ones
   WHERE subject_manager_id = v_subject_id
     AND type = v_type
     AND meeting_date = v_date;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ЗУПИНКА: очікували рівно 1 рядок, під умову підпало %. Нічого не видалено.', n;
  END IF;
  RAISE NOTICE 'Видалено 1 запис 1×1: субʼєкт %, тип %, дата %.', v_subject_id, v_type, v_date;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- A1.4 · КОНТРОЛЬ ПІСЛЯ. Мусить лишитись усе, крім видаленого рядка.
-- 🔴 Порожня видача тут — це НЕ «успіх»: вона означала б, що зникли ВСІ зустрічі
--    людини. Звіряти з A1.1: рядків має стати рівно на один менше.
-- ───────────────────────────────────────────────────────────────────────────
SELECT o.subject_manager_id, m.name AS subject, o.type, o.meeting_date, o.overall, o.enps_score
  FROM one_on_ones o JOIN managers m ON m.id = o.subject_manager_id
 WHERE m.name ILIKE '%орошилов%'
 ORDER BY o.meeting_date DESC, o.type;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ ЧАСТИНА 2 · БОРІВЕЦЬ ОЛЕСЯ — СПОЧАТКУ ЗʼЯСУВАТИ, ХТО ЦЕ                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ───────────────────────────────────────────────────────────────────────────
-- A2.1 · ХТО ВОНА. Найважливіша колонка — `kommo_user_id`: саме вона вирішує,
-- чи має взагалі сенс щось робити в БАЗІ, чи діяти треба в CRM (пояснення в A2.4).
-- `users.*` — окремий, ДРУГИЙ прапорець активності: він керує ВХОДОМ у дашборд і
-- синком не переписується.
-- ───────────────────────────────────────────────────────────────────────────
SELECT m.id                AS manager_id,
       m.name,
       m.kommo_user_id,
       m.email             AS manager_email,
       m.team_id,
       t.name              AS team,
       m.is_team_lead,
       m.is_active         AS manager_is_active,
       u.id                AS user_id,
       u.email             AS login_email,
       u.role,
       u.role_override,
       u.is_active         AS login_is_active,
       u.last_seen
  FROM managers m
  LEFT JOIN teams t ON t.id = m.team_id
  LEFT JOIN users u ON u.manager_id = m.id
 WHERE m.name ILIKE '%орівец%'
 ORDER BY m.id;


-- ───────────────────────────────────────────────────────────────────────────
-- A2.2 · ПОВНА ІНВЕНТАРИЗАЦІЯ ПОСИЛАНЬ — і вона себе НЕ ЗАСТАРІВАЄ.
-- Перелік таблиць береться з КАТАЛОГА БД (`pg_constraint`), а не з мого списку:
-- завтра хтось додасть нову таблицю з посиланням на менеджера — вона зʼявиться тут
-- сама. Список «на памʼять» рівно тут і протухає, а ціна помилки — видалений рядок.
-- ⚠️ ПІДСТАВИТИ `manager_id` з A2.1 у перший рядок.
-- Читати: `rows` > 0 — на людину зіслались, hard-delete упреться у FK або знесе історію.
-- ───────────────────────────────────────────────────────────────────────────
WITH target AS (SELECT 0::int AS manager_id)   -- ← manager_id з A2.1
SELECT c.conrelid::regclass::text AS referencing_table,
       a.attname                  AS column_name,
       (xpath('/row/cnt/text()',
              query_to_xml(format('SELECT count(*) AS cnt FROM %s WHERE %I = %s',
                                  c.conrelid::regclass, a.attname, (SELECT manager_id FROM target)),
                           false, true, '')))[1]::text::int AS rows
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
 WHERE c.confrelid = 'managers'::regclass AND c.contype = 'f'
 ORDER BY rows DESC, referencing_table;


-- ───────────────────────────────────────────────────────────────────────────
-- A2.3 · РОЗШИФРОВКА ТРЬОХ ГОЛОВНИХ. Числа з A2.2 кажуть «скільки», цей запит —
-- «що саме». Угоди тут вирішальні: якщо їх хоч одна, це працююча людина з
-- історією грошей, і видаляти її не можна за жодних обставин
-- (правило проєкту: `is_active` керує списками, а не історичними сумами).
-- ⚠️ ПІДСТАВИТИ той самий manager_id.
-- ───────────────────────────────────────────────────────────────────────────
WITH target AS (SELECT 0::int AS manager_id)   -- ← manager_id з A2.1
SELECT 'deals' AS what, count(*) AS rows,
       min(d.created_at_kommo)::date AS first_seen, max(d.created_at_kommo)::date AS last_seen,
       sum(CASE WHEN d.status_id = 142 THEN 1 ELSE 0 END) AS won_deals,
       sum(CASE WHEN d.status_id = 142 THEN d.price ELSE 0 END) AS won_amount
  FROM deals d WHERE d.manager_id = (SELECT manager_id FROM target)
UNION ALL
SELECT 'tasks', count(*), min(t.created_at)::date, max(t.created_at)::date, NULL, NULL
  FROM tasks t WHERE t.assignee_id = (SELECT manager_id FROM target)
UNION ALL
SELECT 'one_on_ones (як субʼєкт)', count(*), min(o.meeting_date), max(o.meeting_date), NULL, NULL
  FROM one_on_ones o WHERE o.subject_manager_id = (SELECT manager_id FROM target);


-- ───────────────────────────────────────────────────────────────────────────
-- A2.4 · РІШЕННЯ — ЗА ВЛАСНИКОМ. Нижче не команди, а наслідки кожного варіанта.
--
-- 🔴 ГОЛОВНЕ, ЩО ТРЕБА ЗНАТИ ПЕРЕД ВИБОРОМ: `managers` — НЕ наша таблиця, її
--    щопівгодини переписує synKommo:
--      • користувач Є в Kommo  → `is_active = true` ставиться ПРИМУСОВО щосинку
--        (jobs/syncKommo.ts:138-148). Ручний `UPDATE … is_active=false` живе ≤30 хв;
--      • користувача НЕМА в Kommo → синк САМ ставить `is_active = false`
--        (jobs/syncKommo.ts:162-167) — робити нічого не треба;
--      • `DELETE` рядка з непорожнім `kommo_user_id` → наступний синк створить
--        його ЗАНОВО і з НОВИМ `id`. Стара історія лишиться на неіснуючому id:
--        це не «видалили», це «загубили звʼязок».
--
-- ЩО РОБИТИ, ЗАЛЕЖНО ВІД A2.1 і A2.2:
--
--  1) `kommo_user_id` НЕ порожній і людина ще активна в Kommo
--     → у БАЗІ не робити НІЧОГО. Дія — деактивувати обліковий запис у Kommo;
--       дашборд підхопить сам протягом 30 хв. Будь-яка правка тут буде стерта.
--     → Якщо треба закрити ЛИШЕ вхід у дашборд (людина працює в CRM, але в
--       дашборді їй не місце) — це інший прапорець: «Налаштування → користувачі»,
--       `users.is_active`. Синк його не чіпає, тримається.
--
--  2) `kommo_user_id` НЕ порожній, у Kommo її вже немає
--     → `manager_is_active` у A2.1 уже `false`. Нічого не робити: механізм
--       відпрацював. Гроші й історія лишаються — так і має бути.
--
--  3) `kommo_user_id` ПОРОЖНІЙ (ручний/тестовий рядок) і в A2.2 усюди 0
--     → рядок нікому не потрібен, видалення безпечне: A2.5 нижче.
--
--  4) `kommo_user_id` ПОРОЖНІЙ, але посилання Є
--     → НЕ видаляти. `UPDATE managers SET is_active=false WHERE id=…` — тут він
--       протримається (синк ручні рядки не чіпає), а історія лишиться цілою.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- A2.5 · ВИДАЛЕННЯ — ТІЛЬКИ ДЛЯ ВИПАДКУ 3, І ЗАПОБІЖНИК ЦЕ ПЕРЕВІРЯЄ САМ.
-- Блок відмовляється працювати, якщо: рядка немає, у нього є `kommo_user_id`,
-- або на нього хоч щось посилається. Тобто «видалити наосліп» ним НЕ вийде —
-- у небезпечному випадку він падає, не змінивши нічого.
-- ⚠️ ПІДСТАВИТИ manager_id з A2.1.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_manager_id int := 0;                -- ← manager_id з A2.1
  v_kommo bigint; v_name text; refs int; n int;
BEGIN
  SELECT name, kommo_user_id INTO v_name, v_kommo FROM managers WHERE id = v_manager_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ЗУПИНКА: менеджера id=% не існує.', v_manager_id;
  END IF;
  IF v_kommo IS NOT NULL THEN
    RAISE EXCEPTION 'ЗУПИНКА: «%» приїхала з Kommo (kommo_user_id=%). Видалення безглузде — синк створить її знову з новим id. Діяти в CRM.', v_name, v_kommo;
  END IF;

  -- Порахувати посилання ТИМ САМИМ способом, що й A2.2 — по каталогу, а не по памʼяті.
  SELECT COALESCE(sum((xpath('/row/cnt/text()',
           query_to_xml(format('SELECT count(*) AS cnt FROM %s WHERE %I = %s',
                               c.conrelid::regclass, a.attname, v_manager_id), false, true, '')))[1]::text::int), 0)
    INTO refs
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.confrelid = 'managers'::regclass AND c.contype = 'f';

  IF refs > 0 THEN
    RAISE EXCEPTION 'ЗУПИНКА: на «%» посилається % рядків (див. A2.2). Видалення знесло б історію — деактивувати, а не видаляти.', v_name, refs;
  END IF;

  DELETE FROM managers WHERE id = v_manager_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ЗУПИНКА: зачепило % рядків замість 1.', n; END IF;
  RAISE NOTICE 'Видалено менеджера id=% («%»), посилань не було.', v_manager_id, v_name;
END $$;
