-- Teams
-- Note: "КВП" (керівник відділу продажу) is not a deals team — it's a
-- company-wide overview role. No managers/deals are assigned to it; the head
-- of sales gets the 'admin' user role instead, which sees all teams unfiltered.
INSERT INTO teams (name) VALUES ('РНК') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('РПК') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('Лідогенератори') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('Тендери') ON CONFLICT (name) DO NOTHING;

-- Managers (kommo_user_id -> team). Relies on managers already being
-- populated by the Kommo sync job (which inserts one row per Kommo user).
UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'РНК')
  WHERE kommo_user_id IN (12782896, 12644448); -- Михальчевська, Безпамятний

UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'РПК')
  WHERE kommo_user_id IN (12066792, 6062482); -- Шаврова, Дмитрук

UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'Лідогенератори')
  WHERE kommo_user_id IN (8458577, 12812476); -- Ковтонюк, Сердюк

UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'Тендери')
  WHERE kommo_user_id IN (7181916, 15336060, 3379102); -- Шевчук, Дяков, Яцик (тім-лід)

UPDATE managers SET is_team_lead = true
  WHERE kommo_user_id = 3379102; -- Яцик Дмитро — тім-лід Тендерів

-- Pipeline -> funnel stage mapping
-- 8921932 "Перевозки (Продажі повний цикл) (New)" — used by РНК, РПК, Тендери
-- (distinguished by responsible manager / team, not by pipeline)
INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES
  (8921932, 69693668, 'lead_taken'),       -- ВЗЯТО НА ПРОРАХУНОК
  (8921932, 69693672, 'quote_requested'),  -- ПРОПОЗИЦІЮ ЗРОБЛЕНО
  (8921932, 69716252, 'quote_requested'),  -- ВІДКЛАДЕНИЙ ЗАПИТ
  (8921932, 69693676, 'approved'),         -- УМОВИ УЗГОДЖЕНІ
  (8921932, 69716256, 'approved'),         -- ДОКУМЕНТИ ПІДПИСАНІ
  (8921932, 69716260, 'approved'),         -- КОНТРОЛЬ ПЕРЕД ЗАВАНТАЖЕННЯМ
  (8921932, 100274340, 'approved'),        -- Виставлення рахунку (клієнту, ДО відправки) — «взято в роботу»
  (8921932, 69716300, 'approved'),         -- АВТО ПРАЦЮЄ (avto)
  (8921932, 98470988, 'approved'),         -- Перевезення завершено (avto)
  (8921932, 69716304, 'invoiced'),         -- ВИСТАВЛЕНО РАХУНОК (після розвантаження)
  (8921932, 69716312, 'invoiced'),         -- ОЧІКУЄМО ОПЛАТУ (перевізник оплачений)
  (8921932, 69716460, 'paid'),             -- ОПЛАТА ОТРИМАНА
  (8921932, 142, 'paid')                   -- УСПІШНА УГОДА
ON CONFLICT (pipeline_id, status_id) DO UPDATE SET funnel_stage = EXCLUDED.funnel_stage;

-- 8921936 "Продзвін (New)" — Лідогенератори (no quote/invoice/paid stages)
INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES
  (8921936, 69693696, 'lead_taken'),       -- ВЗЯТО В РОБОТУ
  (8921936, 69716492, 'quote_requested'),  -- ОТРИМАНО КОНТАКТИ ОПР
  (8921936, 142, 'quote_requested')        -- КВАЛІФІКОВАНО / ЗАЯВКУ НА ПРОРАХУНОК ОТРИМАНО
ON CONFLICT (pipeline_id, status_id) DO UPDATE SET funnel_stage = EXCLUDED.funnel_stage;

-- 155304 "Перевозки (Продажі повний цикл)" — the OLD full-cycle pipeline,
-- direct predecessor of 8921932. Most historical paid orders (and thus
-- repeat-client history) live here, so it must be mapped too. Mirrors the
-- New pipeline's semantics; status 142 = won/paid as in 8921932.
INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES
  (155304, 26010520, 'lead_taken'),        -- Incoming leads
  (155304, 11804491, 'lead_taken'),        -- Взято на прорахунок
  (155304, 10847806, 'quote_requested'),   -- Пропозицію зроблено
  (155304, 69500840, 'quote_requested'),   -- Відкладений запит
  (155304, 10869081, 'approved'),          -- Умови узгоджені
  (155304, 10883250, 'approved'),          -- Документи підписані
  (155304, 62940064, 'approved'),          -- Контроль перед завантаженням
  (155304, 10937178, 'approved'),          -- Авто працює
  (155304, 42639144, 'invoiced'),          -- Виставлено рахунок (після розвантаження)
  (155304, 42639147, 'invoiced'),          -- Документы получены
  (155304, 25044997, 'invoiced'),          -- Очікуємо оплату (перевізник оплачений)
  (155304, 62940068, 'invoiced'),          -- Очікуємо оплату (перевізник не оплачений)
  (155304, 60412544, 'paid'),              -- Оплата отримана
  (155304, 142, 'paid')                    -- Успішна угода
ON CONFLICT (pipeline_id, status_id) DO UPDATE SET funnel_stage = EXCLUDED.funnel_stage;
