-- Teams
INSERT INTO teams (name) VALUES ('РНК') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('РПК') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('Лідогенератори') ON CONFLICT (name) DO NOTHING;
INSERT INTO teams (name) VALUES ('КВП') ON CONFLICT (name) DO NOTHING;

-- Managers (kommo_user_id -> team). Relies on managers already being
-- populated by the Kommo sync job (which inserts one row per Kommo user).
UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'РНК')
  WHERE kommo_user_id IN (12782896, 12644448); -- Михальчевська, Безпамятний

UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'РПК')
  WHERE kommo_user_id IN (12066792, 3379102, 6062482); -- Шаврова, Яцик, Дмитрук

UPDATE managers SET team_id = (SELECT id FROM teams WHERE name = 'Лідогенератори')
  WHERE kommo_user_id IN (8458577, 12812476); -- Ковтонюк, Сердюк

-- Pipeline -> funnel stage mapping
-- 8921932 "Перевозки (Продажі повний цикл) (New)" — used by РНК, РПК, Тендери
-- (distinguished by responsible manager / team, not by pipeline)
INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES
  (8921932, 69693668, 'lead_taken'),       -- ВЗЯТО НА ПРОРАХУНОК
  (8921932, 69693672, 'quote_requested'),  -- ПРОПОЗИЦІЮ ЗРОБЛЕНО
  (8921932, 69693676, 'approved'),         -- УМОВИ УЗГОДЖЕНІ
  (8921932, 100274340, 'invoiced'),        -- Виставлення рахунку
  (8921932, 69716304, 'invoiced'),         -- ВИСТАВЛЕНО РАХУНОК (після розвантаження)
  (8921932, 69716460, 'paid'),             -- ОПЛАТА ОТРИМАНА
  (8921932, 142, 'paid')                   -- УСПІШНА УГОДА
ON CONFLICT (pipeline_id, status_id) DO UPDATE SET funnel_stage = EXCLUDED.funnel_stage;

-- 8921936 "Продзвін (New)" — Лідогенератори (no quote/invoice/paid stages)
INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES
  (8921936, 69693696, 'lead_taken'),       -- ВЗЯТО В РОБОТУ
  (8921936, 69716492, 'quote_requested'),  -- ОТРИМАНО КОНТАКТИ ОПР
  (8921936, 142, 'quote_requested')        -- КВАЛІФІКОВАНО / ЗАЯВКУ НА ПРОРАХУНОК ОТРИМАНО
ON CONFLICT (pipeline_id, status_id) DO UPDATE SET funnel_stage = EXCLUDED.funnel_stage;
