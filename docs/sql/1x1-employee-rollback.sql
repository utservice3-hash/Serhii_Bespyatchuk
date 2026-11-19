-- ↩️ ВІДКАТ КЛЮЧА 1×1 «людина з Найму» → «менеджер Kommo» (19.11.2026). Запускати ЛИШЕ разом із відкатом коду
-- до версії без `subject_employee_id` (старий код пише по ключу `(subject_manager_id, type, meeting_date)`).
-- Нічого не видаляє. Якщо вже є записи людей без Kommo (`subject_manager_id IS NULL`), ЗУПИНЯЄТЬСЯ з їхнім переліком:
-- старий ключ їх не вмістить, і рішення, що з ними робити, — за людиною, а не за скриптом. Тримає гейт `#9999`.
-- Колонки `subject_employee_id` / `tasks.o2o_employee_id` лишаються (старий код їх не читає).
BEGIN;
DO $$
DECLARE bad text; pkname text;
BEGIN
  SELECT string_agg(format('%s · %s · %s', e.full_name, o.type, o.meeting_date), '; ' ORDER BY e.full_name, o.meeting_date)
    INTO bad
    FROM one_on_ones o JOIN employees e ON e.id = o.subject_employee_id
   WHERE o.subject_manager_id IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'відкат ключа 1×1 зупинено: записи людей без Kommo, старий ключ їх не вмістить: %', bad;
  END IF;
  SELECT c.conname INTO pkname FROM pg_constraint c WHERE c.conrelid = 'one_on_ones'::regclass AND c.contype = 'p';
  IF pkname IS NOT NULL THEN EXECUTE 'ALTER TABLE one_on_ones DROP CONSTRAINT ' || quote_ident(pkname); END IF;
  ALTER TABLE one_on_ones ALTER COLUMN subject_manager_id SET NOT NULL;
  ALTER TABLE one_on_ones ADD PRIMARY KEY (subject_manager_id, type, meeting_date);
  ALTER TABLE one_on_ones ALTER COLUMN subject_employee_id DROP NOT NULL;
END $$;
COMMIT;
