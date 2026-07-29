CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kommo_group_id BIGINT UNIQUE
);

ALTER TABLE teams ADD COLUMN IF NOT EXISTS kommo_group_id BIGINT UNIQUE;

CREATE TABLE IF NOT EXISTS managers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  kommo_user_id BIGINT UNIQUE,
  is_team_lead BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE managers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE managers ADD COLUMN IF NOT EXISTS email TEXT;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'team_lead', 'manager')),
  manager_id INTEGER REFERENCES managers(id),
  team_id INTEGER REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-provisioned manager logins: keep the generated password visible to the
-- admin (internal tool) and allow deactivating users when a manager leaves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS initial_password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pipeline_stage_map (
  pipeline_id BIGINT NOT NULL,
  status_id BIGINT NOT NULL,
  funnel_stage TEXT NOT NULL CHECK (funnel_stage IN
    ('lead_taken', 'quote_requested', 'approved', 'invoiced', 'paid')),
  PRIMARY KEY (pipeline_id, status_id)
);

CREATE TABLE IF NOT EXISTS deals (
  kommo_id BIGINT PRIMARY KEY,
  name TEXT,
  manager_id INTEGER REFERENCES managers(id),
  kommo_user_id BIGINT,
  pipeline_id BIGINT,
  status_id BIGINT,
  price NUMERIC DEFAULT 0,
  created_at_kommo TIMESTAMPTZ,
  updated_at_kommo TIMESTAMPTZ,
  closed_at_kommo TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_name TEXT,
  client_key TEXT
);

ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_name TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_key TEXT;
CREATE INDEX IF NOT EXISTS idx_deals_client_key ON deals(client_key);

-- Lead source attribution (for conversion-by-source). Raw values are kept so
-- the derived channel can be reclassified later without re-pulling from Kommo.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_generator TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_source TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_channel TEXT; -- 'ad' | 'leadgen' | 'other'
ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_type TEXT; -- «форма расчета»: Безнал с НДС / без НДС / Наличные / ВАЛЮТА
CREATE INDEX IF NOT EXISTS idx_deals_lead_channel ON deals(lead_channel);

-- КРОК 6.1: web/гео-мітки реклами (Kommo 481995/481997/2098331/2098327/2098329) —
-- сира атрибуція для конверсії реклами по каналах. traf_type ∈ cpc/organic/referral/none.
-- ДВА взаємовиключні покоління міток: платний сигнал = utm_medium='cpc' АБО
-- traf_type='cpc' (кожне покриває своє покоління; GLOSSARY §platned).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS adv_camp TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS traf_src TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS traf_type TEXT;
CREATE INDEX IF NOT EXISTS idx_deals_traf_type ON deals(traf_type);
CREATE INDEX IF NOT EXISTS idx_deals_utm_medium ON deals(utm_medium);

-- «Мінусова угода» (Kommo select 2098529 = «Мінус»): сторно/повернення. Знак `price`
-- дає ЦЕ поле, не слово в назві: price = is_minus ? -abs(budget) : +abs(budget).
-- price лишається чистою функцією (бюджет, is_minus) → само-виправляється в обидва боки.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS is_minus BOOLEAN NOT NULL DEFAULT false;

-- Два якорі (Правило №1 глосарію): unload_at = дата акту (Kommo 463253,
-- «Дата выгрузки (Дата акта)») — ФІНАНСОВИЙ якір; load_at = «Дата загрузки»
-- (473637) — операційне поле, не якір. Якір продажів — вхід у 142
-- (deal_stage_events), не тут.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS unload_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS load_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_deals_unload_at ON deals(unload_at);
-- Р2: «Запланована дата оплати» (Kommo 2097273) — обіцяна клієнтом дата оплати
-- для суми очікування в грошовій зоні (виставлено рахунок → очікуємо оплату).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS planned_payment_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_deals_planned_payment_at ON deals(planned_payment_at);
-- «Причина отказа» (Kommo select 2097265) — текст значення. Нецільові (owner) =
-- реклама ∩ reject_reason ∈ {«Дубль», «Перевізник»}. Populate у syncKommo щосинку.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS reject_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_deals_reject_reason ON deals(reject_reason);

ALTER TABLE managers ADD COLUMN IF NOT EXISTS is_team_lead BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_deals_manager ON deals(manager_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(pipeline_id, status_id);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Sync observability: surface the health of the Kommo sync so a stalled/failing
-- job is visible (and alertable) instead of silently freezing the data.
-- last_synced_at stays the incremental WATERMARK (only advanced on success);
-- the columns below describe the latest run for monitoring.
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_run_started_at TIMESTAMPTZ;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_deal_count INTEGER;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_duration_ms INTEGER;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
-- Watermark for the lead_status_changed events feed (separate from the deal sync).
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

-- Stage-transition history: when each deal ENTERED a status, sourced from Kommo's
-- lead_status_changed events. Lets period metrics (notably "успіх") count deals
-- by the date they entered the stage — matching CRM — instead of closed_at,
-- which a watermark-based deal sync can't reconstruct for past months.
CREATE TABLE IF NOT EXISTS deal_stage_events (
  id BIGSERIAL PRIMARY KEY,
  kommo_id BIGINT NOT NULL,
  status_id BIGINT NOT NULL,
  pipeline_id BIGINT,
  funnel_stage TEXT,            -- mapped at insert time; NULL if status not in the map
  changed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'kommo_events'
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deal_stage_event ON deal_stage_events(kommo_id, status_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_dse_stage_time ON deal_stage_events(status_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_dse_pipeline_stage_time ON deal_stage_events(pipeline_id, status_id, changed_at);

-- "Передані заявки": a lead-gen qualification lead handed to a sales manager.
-- The signal is Kommo's entity_responsible_changed event on a Кваліфікація-
-- pipeline lead (the moment a manager "takes" the lead — the same trigger as
-- the Telegram notification). Only such leads are stored here.
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_transfer_at TIMESTAMPTZ;

-- Real (human) activity per deal — max created_at of a lead note made by an
-- actual user (created_by <> 0), i.e. a call/text/manual note. Independent of
-- Salesbot, which bumps a lead's updated_at without any manager working it.
-- Used by "stuck deals": a deal with no human activity for a while is stuck.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS first_activity_at TIMESTAMPTZ; -- перший людський контакт (для «час опрацювання»)
-- Дата останнього ДЗВІНКА клієнту (лише call_in/call_out, created_by<>0), окремо від будь-якої активності.
-- Живить прапорець «метушня без контакту» у «Застряглих»: свіжа нотатка є, але місяць без дзвінка.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_call_at TIMESTAMPTZ;
-- Блок B (логістика): «Тип запиту» (2097965 → напрямок) + «Канал продажу» (2099549).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS request_type TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_activity_note_at TIMESTAMPTZ;

-- Daily ad spend/results pulled from the Google Ads budget sheet (syncAdBudget).
-- Accumulates history: each run refreshes the current month's rows; past months
-- stay. Used by the КВП report (Реклама → рекламний бюджет план/факт).
-- Composite daily KPI task: one row per working day bundling ALL that day's
-- metric targets (sum/revenue, ads, leadgen, avg check, conversion) as
-- [{metric,target,actual,done}]. Lets a weekly plan land as N daily tasks
-- (one per day) instead of N×metrics rows. evaluateKpiTasks fills actual/done.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metrics_json JSONB;
-- Reactivation tasks bundle a list of clients as a checklist the manager ticks
-- off: [{clientKey, clientName, orders, revenue, lastPaid, category, done}].
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist_json JSONB;
-- Довільні підзадачі будь-якої задачі, кожну можна відмітити виконаною:
-- [{title, done}]. Прогрес X/N показується на картці/рядку.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subtasks_json JSONB;

CREATE TABLE IF NOT EXISTS ad_budget_daily (
  day DATE PRIMARY KEY,
  budget_plan NUMERIC DEFAULT 0,
  budget_fact NUMERIC DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_transfer_events (
  kommo_id BIGINT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  to_user_id BIGINT,
  PRIMARY KEY (kommo_id, changed_at)
);
CREATE INDEX IF NOT EXISTS idx_lte_time ON lead_transfer_events(changed_at);

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  plan_date DATE NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN
    ('lead_taken', 'quote_requested', 'approved', 'invoiced', 'paid', 'payment_amount')),
  planned_value NUMERIC NOT NULL,
  UNIQUE (manager_id, plan_date, metric)
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN
    ('todo_list', 'to_realize', 'planned', 'not_started',
     'deferred', 'in_progress', 'ball_on_executor',
     'ready_for_approval', 'done')),
  deadline DATE,
  assignee_id INTEGER REFERENCES managers(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  comments TEXT,
  department TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

-- Weekly/monthly KPI plans. A team-lead sets a target for a manager; the
-- "ads_count" metric is decomposed into per-day sub-tasks (auto), while
-- "avg_check"/"conversion" are evaluated as a period aggregate. A daily job
-- fills actual_value from CRM data and auto-completes tasks that hit target.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metric TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_value NUMERIC;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS actual_value NUMERIC;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_date DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_tasks_kpi ON tasks(metric, plan_date) WHERE auto;

CREATE TABLE IF NOT EXISTS receivables (
  id SERIAL PRIMARY KEY,
  client_key TEXT NOT NULL,
  client_name TEXT NOT NULL,
  manager_id INTEGER REFERENCES managers(id),
  manager_name_raw TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  limit_days INTEGER,
  overdue_days INTEGER,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receivables_manager ON receivables(manager_id);
CREATE INDEX IF NOT EXISTS idx_receivables_client_key ON receivables(client_key);
-- Джерело рядка: 'sheet' = гугл-таблиця дебіторки (безнал, ДЖЕРЕЛО ПРАВДИ);
-- 'cash' = готівкові з CRM (insertCashReceivables). Основний тотал дебіторки =
-- ЛИШЕ 'sheet' (1:1 з таблицею); готівка — окремою позначкою (рішення власника).
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sheet';

-- Team-lead notes on receivables. Kept separate from `receivables` because that
-- table is TRUNCATEd on every Google-Sheet sync; notes are keyed by client_key
-- so they survive re-syncs.
CREATE TABLE IF NOT EXISTS receivable_notes (
  client_key TEXT PRIMARY KEY,
  comment TEXT,
  due_date DATE,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Нотатки до КОНКРЕТНОГО рахунку дебіторки (дедлайн оплати + коментар менеджера).
-- Окремо від receivable_invoices, бо той TRUNCATE-иться щосинку. Прострочений
-- дедлайн → авто-задача менеджеру «отримати оплату» (task_created_at = анти-дубль).
CREATE TABLE IF NOT EXISTS receivable_invoice_notes (
  client_key TEXT NOT NULL,
  invoice_no TEXT NOT NULL,
  due_date DATE,
  comment TEXT,
  task_created_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, invoice_no)
);
-- Анти-дубль авто-задачі і для КЛІЄНТСЬКОГО дедлайну (receivable_notes.due_date).
ALTER TABLE receivable_notes ADD COLUMN IF NOT EXISTS task_created_at TIMESTAMPTZ;

-- Реактивація: сплячі/втрачені клієнти, яких тімлід передав менеджеру в роботу.
-- Обовʼязкові робочі поля: план/факт, 1-й контакт → результат, 2-й контакт → результат.
CREATE TABLE IF NOT EXISTS reactivation_clients (
  client_key TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  category TEXT,                               -- sleeping | lost
  plan NUMERIC NOT NULL DEFAULT 0,
  contact1_date DATE,
  contact1_result TEXT,
  contact2_date DATE,
  contact2_result TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'reactivated', 'refused')),
  comment TEXT,
  added_by INTEGER REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reactivation_manager ON reactivation_clients(manager_id);

-- Ручні правки списку постійних клієнтів (лише адмін): прибрати з постійних,
-- передати іншому менеджеру/команді, або примусово додати. Список постійних
-- рахується авто з CRM — ця таблиця його коригує, не змінюючи самі угоди.
CREATE TABLE IF NOT EXISTS loyalty_overrides (
  client_key TEXT PRIMARY KEY,
  client_name TEXT,
  hidden BOOLEAN NOT NULL DEFAULT false,        -- прибрати з постійних
  pinned_manager_id INTEGER REFERENCES managers(id), -- передати цьому менеджеру
  force_regular BOOLEAN NOT NULL DEFAULT false, -- примусово вважати постійним
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Monthly goals / objectives a team lead (or КВП) sets for a month — a
-- high-level goals tracker separate from the numeric plans. Team-lead → own
-- team (team_id), admin → team_id NULL (department-wide) or a chosen team.
CREATE TABLE IF NOT EXISTS monthly_goals (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  title TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'done'
  comment TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monthly_goals_month ON monthly_goals(month);

-- Per-invoice detail behind each client's receivable balance (the "выгрузка"
-- tab of the debt sheet). Refreshed wholesale each sync like `receivables`.
CREATE TABLE IF NOT EXISTS receivable_invoices (
  id SERIAL PRIMARY KEY,
  client_key TEXT NOT NULL,
  client_name TEXT NOT NULL,
  manager_id INTEGER REFERENCES managers(id),
  manager_name_raw TEXT,
  invoice_no TEXT,
  invoice_date DATE,
  amount NUMERIC NOT NULL DEFAULT 0,
  edrpou TEXT,
  service_url TEXT,
  note TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receivable_invoices_client ON receivable_invoices(client_key);

-- Per-regular-client monthly plan (the team-lead's "план по постійних клієнтах"
-- replicated from the manual sheet). Plan is a monthly target per client that the
-- frontend decomposes by week; fact is auto-filled from CRM. The metadata columns
-- (forecast / realization % / international / call link / comment) are filled by
-- the team lead. One row per client per month.
CREATE TABLE IF NOT EXISTS repeat_client_plans (
  client_key TEXT NOT NULL,
  month DATE NOT NULL,
  manager_id INTEGER REFERENCES managers(id),
  plan NUMERIC NOT NULL DEFAULT 0,
  forecast TEXT,            -- 'same' | 'down' | 'up'
  realization_pct NUMERIC,
  international BOOLEAN,     -- чи є міжнародні перевезення
  we_do BOOLEAN,            -- чи здійснюємо ми їх
  call_link TEXT,           -- лінк на запис розмови
  comment TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, month)
);
-- Approval workflow: the manager proposes the plan (status='pending'), the team
-- lead approves it (status='approved'). Team-lead/admin edits land approved.
ALTER TABLE repeat_client_plans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE repeat_client_plans ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id);
ALTER TABLE repeat_client_plans ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Monthly snapshot of "carried-over" deals: the value of deals still in
-- progress (approved→invoiced→payment received, NOT yet closed as Успішна) as
-- of the 1st of the month. Captured once per month (fixed figure).
CREATE TABLE IF NOT EXISTS monthly_carryover (
  month DATE PRIMARY KEY,
  amount NUMERIC NOT NULL DEFAULT 0,
  deals INTEGER NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same carried-over snapshot, but per manager (for the manager report).
CREATE TABLE IF NOT EXISTS monthly_carryover_mgr (
  month DATE NOT NULL,
  manager_id INTEGER NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  deals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, manager_id)
);

-- Monthly funnel plan per manager per stage (the "план на місяць" column of the
-- managers' funnel report). Fact is computed from CRM; this is the manual target.
CREATE TABLE IF NOT EXISTS funnel_plans (
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  month DATE NOT NULL,        -- first day of the plan month
  stage TEXT NOT NULL,        -- lead_taken | quote_requested | approved | invoiced | paid
  planned_value NUMERIC NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, month, stage)
);

-- Company / industry news shown to managers.
CREATE TABLE IF NOT EXISTS news (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('company', 'logistics', 'sales')),
  title TEXT NOT NULL,
  body TEXT,
  author TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_category ON news(category, created_at DESC);
ALTER TABLE news ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Daily approximate price per km by truck tonnage.
CREATE TABLE IF NOT EXISTS km_prices (
  price_date DATE PRIMARY KEY DEFAULT current_date,
  t20 NUMERIC,
  t10 NUMERIC,
  t5 NUMERIC,
  t2 NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Direct messages between dashboard users (internal messenger).
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, read_at);

-- Configurable app settings (single JSON row), editable by admins from the UI.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT single_settings_row CHECK (id = 1)
);
INSERT INTO app_settings (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS limit_days INTEGER;
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS overdue_days INTEGER;

-- Team-lead feedback / bug reports. Team-leads submit corrections; an admin
-- approves or rejects each item, and the dev resolves the approved ones.
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  section TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','resolved')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_author ON feedback(author_user_id, created_at DESC);

-- "Робота з АІ": a shared chat/log where the admin (and a designated assistant
-- account) post change requests + context for the AI to pick up and act on.
CREATE TABLE IF NOT EXISTS ai_messages (
  id SERIAL PRIMARY KEY,
  author_user_id INTEGER REFERENCES users(id),
  author_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','assistant')),
  body TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_time ON ai_messages(created_at);
-- Attached images/files on a chat message: JSON array of {url, name}.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS attachments JSONB;

-- «Мої звіти»: dashboard widgets the AI builds on request. Each widget is a
-- read-only SQL query + a render config; the reports section runs the SQL live
-- and draws it. Visibility scopes who sees it (admin / team leads / everyone).
CREATE TABLE IF NOT EXISTS ai_widgets (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  chart_type TEXT NOT NULL DEFAULT 'table' CHECK (chart_type IN ('table','bar','line','kpi')),
  sql TEXT NOT NULL,
  config JSONB,
  visibility TEXT NOT NULL DEFAULT 'admin' CHECK (visibility IN ('admin','leads','all')),
  created_by INTEGER REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_widgets_order ON ai_widgets(sort_order, id);

-- «Калькулятор ставок» (порт lardiweb): власний архів цін Lardi — Lardi не
-- віддає історію, тому накопичуємо самі. Дедуп за ID заявки на маршрут.
CREATE TABLE IF NOT EXISTS lardi_offers (
  side TEXT NOT NULL,
  offer_id BIGINT NOT NULL,
  from_id BIGINT NOT NULL,
  to_id BIGINT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  cargo TEXT, mass NUMERIC, load_type TEXT,
  total NUMERIC, per_ton NUMERIC, per_km NUMERIC,
  is_uah BOOLEAN, currency TEXT, negotiable BOOLEAN,
  bodies TEXT, company TEXT, face TEXT, phones JSONB,
  frm TEXT, tox TEXT, dist_km NUMERIC, dt TEXT, payform TEXT,
  PRIMARY KEY (side, offer_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_lardi_offers_route ON lardi_offers(from_id, to_id, side, first_seen);

-- Маршрути, які запитували менеджери — їх переопитує збирач за розкладом.
CREATE TABLE IF NOT EXISTS lardi_routes (
  from_id BIGINT NOT NULL,
  to_id BIGINT NOT NULL,
  from_name TEXT, to_name TEXT,
  from_area BIGINT, to_area BIGINT,
  from_lat NUMERIC, from_lon NUMERIC, to_lat NUMERIC, to_lon NUMERIC,
  last_query TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id)
);

-- Статистика використання калькулятора (запити менеджерів).
CREATE TABLE IF NOT EXISTS lardi_usage (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER,
  ip TEXT,
  frm TEXT, tox TEXT
);
CREATE INDEX IF NOT EXISTS idx_lardi_usage_ts ON lardi_usage(ts);

-- «Ціни по місту» (заміна ТГ-скритника): менеджери самі ведуть базу цін,
-- вантажників і контактів по містах — з пошуком у калькуляторі ставок.
CREATE TABLE IF NOT EXISTS city_info (
  id SERIAL PRIMARY KEY,
  city TEXT NOT NULL,
  city_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('price','loaders','contact')),
  title TEXT,
  phone TEXT,
  price TEXT,
  comment TEXT,
  author_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_city_info_key ON city_info(city_key);

-- Перевізники з CRM для калькулятора ставок: контакти успішних угод повного
-- циклу, що НЕ схожі на клієнта (без гео/таргет-міток, не основний, без
-- компанії). Пошук по місту = згадка міста в назві угоди (маршруті).
CREATE TABLE IF NOT EXISTS carrier_trips (
  contact_id BIGINT NOT NULL,
  deal_kommo_id BIGINT NOT NULL,
  name TEXT,
  phone TEXT,
  deal_name TEXT,
  deal_date DATE,
  PRIMARY KEY (contact_id, deal_kommo_id)
);
CREATE INDEX IF NOT EXISTS idx_carrier_trips_phone ON carrier_trips(phone);

-- Угоди, які вже опрацьовані збирачем перевізників (навіть якщо перевізника
-- в них не знайдено) — щоб не тягнути з Kommo повторно.
CREATE TABLE IF NOT EXISTS carrier_sync_done (
  deal_kommo_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Регламенти та документи ─────────────────────────────────────────────
-- Файлова база відділу продажу: дерево папок + файли на диску (тека
-- `uploads/documents`, персистить між деплоями, потрапляє в нічний бекап).
-- Читають усі автентифіковані; керує (створення/перейменування/видалення/
-- завантаження) лише КВП (роль admin). Каскад: видалення папки прибирає
-- вкладені папки й файли (фізичні файли чистить роут перед DELETE).
CREATE TABLE IF NOT EXISTS doc_folders (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES doc_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_folders_parent ON doc_folders(parent_id);

CREATE TABLE IF NOT EXISTS doc_files (
  id SERIAL PRIMARY KEY,
  folder_id INTEGER REFERENCES doc_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,          -- відображувана назва (оригінальне імʼя файла)
  stored_name TEXT NOT NULL,   -- uuid-імʼя на диску
  category TEXT,               -- тег: Регламент / Шаблон / Інструкція / Інше
  mime TEXT,
  size_bytes BIGINT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_files_folder ON doc_files(folder_id);

-- «Реєстр» лідоген-бота (Google Sheet): кожен рядок = вхід ліда в статус
-- «Нова заявка від лідогенератора» (69716164). Джерело правди для «переданих
-- заявок» (наш lead_transfer_events рахував зміни відповідального — завищував).
-- TRUNCATE+insert щосинку (як receivables). Дублі можливі (той самий lead_id з
-- різним transferred_at) — рахуємо DISTINCT lead_id за період.
CREATE TABLE IF NOT EXISTS leadgen_registry (
  lead_id BIGINT NOT NULL,
  lead_name TEXT,
  manager_name TEXT,
  team_name TEXT,
  transferred_at TIMESTAMPTZ NOT NULL,
  taken_at TIMESTAMPTZ,
  first_call_at TIMESTAMPTZ,
  reaction_min NUMERIC,
  time_to_call_min NUMERIC,
  PRIMARY KEY (lead_id, transferred_at)
);
CREATE INDEX IF NOT EXISTS idx_leadgen_registry_time ON leadgen_registry(transferred_at);

-- ПОСТІЙНИЙ слід лідоген-дотику. `leadgen_registry` перезаписується щосинку
-- (TRUNCATE+insert, тримає ~5 тижнів), тож дотик з нього треба зберегти
-- назавжди — інакше угоди старітимуть і знову ставали б «вручну». Правило:
-- «раз побачили лід як лідоген → назавжди лідоген». Append-only: заповнюється
-- у syncKommo (upsertLeadgenTouch) з РЕЄСТРУ (джерело правди передач). Ключ =
-- kommo_id самого ліда (95% реєстрових лідів = сам FC-запис 1:1), тож
-- reclassifyAdChannel джойнить угода→слід напряму по kommo_id (БЕЗ client_key —
-- уникаємо колізії порожніх ключів). Колонка `source` лишена під майбутні
-- джерела; lead_transfer_events сюди НЕ пишемо (завищує; вже в lg-CTE reclassify).
CREATE TABLE IF NOT EXISTS leadgen_touch (
  lead_kommo_id BIGINT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transfer_date DATE,
  source TEXT NOT NULL -- 'registry' | 'transfer_events'
);

-- Департаментні (top-down) плани КВП для Звіту КВП: цілі по відділу на місяць,
-- НЕ привʼязані до менеджера (тому окремо від plans, де manager_id NOT NULL).
-- Ключ (month, metric). Виручка лишається в plans (сума по менеджерах,
-- read-only тут); сюди КВП ставить решту цілей (авто, ліди, конверсія, сер.чек,
-- нові/постійні, лідоген тощо), щоб «Викон.%» був реальним для кожного рядка.
CREATE TABLE IF NOT EXISTS kvp_plans (
  month DATE NOT NULL,
  metric TEXT NOT NULL,
  planned_value NUMERIC NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month, metric)
);

-- Ван-ту-вани (1-on-1): зустріч із співробітником. Тімлід проводить зі своєю
-- командою; операційний/КВП (admin) — з тімлідами й бачить усіх.
-- Менеджери 1-on-1 НЕ бачать. answers = { questionKey: {score?:1..10, text?} }.
-- PK ставить DO-блок нижче (потребує колонки `type`, що додається ALTER-ом).
CREATE TABLE IF NOT EXISTS one_on_ones (
  subject_manager_id INTEGER NOT NULL REFERENCES managers(id),
  meeting_date DATE NOT NULL,    -- ДАТА ЗУСТРІЧІ — авторитетна: кожна зустріч = окремий запис
  conducted_by INTEGER REFERENCES users(id),
  answers JSONB NOT NULL DEFAULT '{}',
  overall NUMERIC,               -- середнє по scored-відповідях (кеш для статистики)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1×1 ПЕРЕРОБКА: три типи (A/Б/В), конфігуровані набори питань, приватність.
-- Тип запису + версія форми, проти якої заповнено (історія рендериться проти СВОЄЇ версії).
-- eNPS (тип В) — ОКРЕМЕ поле, не мішається з overall. notes — панель «Нотатки HR» (тип В).
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'A';
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS form_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS enps_score INTEGER;   -- 0..10 (тип В)
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS enps_reason TEXT;
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS notes JSONB;          -- панель «Нотатки HR»
-- ЖУРНАЛ ЗА ДАТАМИ: дата зустрічі АВТОРИТЕТНА — кожна зустріч окремий запис (у місяці їх
-- може бути кілька). Колонки `month` БІЛЬШЕ НЕМАЄ: місяць = date_trunc('month', meeting_date),
-- єдине джерело. Легасі-записи (місячний бакет) переносяться на 1-ше число свого місяця —
-- детерміновано, без втрат; стара унікальність (subject,type,month) колізій не дає.
ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS meeting_date DATE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'one_on_ones'
                AND column_name = 'month') THEN
    EXECUTE 'UPDATE one_on_ones SET meeting_date = month WHERE meeting_date IS NULL';
    -- знімає заразом старий PK і idx_one_on_ones_month (залежні від колонки)
    EXECUTE 'ALTER TABLE one_on_ones DROP COLUMN month';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'one_on_ones'
                AND column_name = 'meeting_date' AND is_nullable = 'YES') THEN
    EXECUTE 'ALTER TABLE one_on_ones ALTER COLUMN meeting_date SET NOT NULL';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_one_on_ones_mdate ON one_on_ones(meeting_date);
-- Міграція PK → (subject_manager_id, type, meeting_date). Ідемпотентно.
DO $$
DECLARE pkcols text; pkname text;
BEGIN
  SELECT c.conname,
         string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
    INTO pkname, pkcols
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.conrelid = 'one_on_ones'::regclass AND c.contype = 'p'
  GROUP BY c.conname;
  IF pkcols IS DISTINCT FROM 'subject_manager_id,type,meeting_date' THEN
    IF pkname IS NOT NULL THEN EXECUTE 'ALTER TABLE one_on_ones DROP CONSTRAINT ' || quote_ident(pkname); END IF;
    ALTER TABLE one_on_ones ADD PRIMARY KEY (subject_manager_id, type, meeting_date);
  END IF;
END $$;

-- Версіоновані набори питань. questions JSONB = { sections:[{key,title,note?,questions:[{qKey,label,field,quarterly?}]}], enps?, notes? }.
-- Редактор у Налаштуваннях створює НОВУ version; історія тримається за (type, version, qKey).
CREATE TABLE IF NOT EXISTS one_on_one_forms (
  type       TEXT NOT NULL,                 -- 'A' | 'B' | 'V'
  version    INTEGER NOT NULL,
  questions  JSONB NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT false,-- активна версія типу (одна на тип)
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (type, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_o2o_forms_active ON one_on_one_forms(type) WHERE is_active;

-- Графік чергування: тімлід (РНК) / адмін призначає менеджерів на конкретні дні
-- (закривати вхідні заявки у вечірні/вихідні «вікна», де реакція провисає).
-- Один рядок = (день × менеджер × зміна). shift: 'day' | 'evening' | 'weekend'.
-- team_id денормалізований для швидкого скоуп-фільтра. Менеджер бачить свої дні.
CREATE TABLE IF NOT EXISTS duty_schedule (
  id SERIAL PRIMARY KEY,
  duty_date DATE NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  team_id INTEGER REFERENCES teams(id),
  shift TEXT NOT NULL DEFAULT 'day',       -- day | evening | weekend
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (duty_date, manager_id, shift)
);
CREATE INDEX IF NOT EXISTS idx_duty_date ON duty_schedule(duty_date);
CREATE INDEX IF NOT EXISTS idx_duty_manager ON duty_schedule(manager_id, duty_date);

-- Календар команди — ВІДСУТНОСТІ (окремо від duty_schedule; чергування лишається як є).
-- Один рядок = одна відмітка відсутності менеджера. Поденні типи (day_off/short_day) →
-- start_date = end_date. Діапазонні (vacation/sick) → [start_date, end_date] показуються
-- смугою через дні. `hours` — лише для short_day (скорочений день). team_id денормалізований
-- з менеджера (як у duty_schedule) для швидкого скоуп-фільтра.
--   ПОГОДЖЕННЯ: кожна відмітка створюється status='pending' і набуває чинності лише після
--   approve (тімлід своєї команди / адмін будь-кого). Для робочих днів (Phase 2) враховуються
--   ЛИШЕ approved. АУДИТ: created_by/created_at (хто/коли відмітив), approved_by/approved_at
--   (хто/коли погодив) — для HR.
CREATE TABLE IF NOT EXISTS team_calendar_absences (
  id SERIAL PRIMARY KEY,
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  team_id INTEGER REFERENCES teams(id),
  kind TEXT NOT NULL CHECK (kind IN ('day_off','vacation','sick','short_day')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,                       -- = start_date для поденних; діапазон для vacation/sick
  hours NUMERIC,                                -- лише short_day (к-сть годин скороченого дня)
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_by INTEGER REFERENCES users(id),      -- хто відмітив (аудит)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by INTEGER REFERENCES users(id),     -- хто погодив/відхилив (аудит)
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_absence_range ON team_calendar_absences(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_absence_manager ON team_calendar_absences(manager_id, start_date);
CREATE INDEX IF NOT EXISTS idx_absence_status ON team_calendar_absences(status);
CREATE INDEX IF NOT EXISTS idx_absence_team ON team_calendar_absences(team_id, start_date);

-- Держсвята — фіксує ВРУЧНУ адмін (окремий тип неробочого дня, глобальний для всіх команд;
-- автоматично НЕ тягнемо). Погодження не потребує (адмін — авторитет). Живить робочі дні
-- (Phase 2) так само, як approved-відсутності, але для всіх менеджерів одразу.
CREATE TABLE IF NOT EXISTS company_holidays (
  id SERIAL PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holiday_date ON company_holidays(holiday_date);

-- Історія змін планів по постійних клієнтах: кожне збереження/затвердження пише
-- рядок (хто, коли, дія, підсумковий план і статус). Для аудиту й «історії» в UI.
CREATE TABLE IF NOT EXISTS repeat_client_plan_history (
  id SERIAL PRIMARY KEY,
  client_key TEXT NOT NULL,
  month DATE NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,             -- 'save' | 'approve'
  plan NUMERIC,
  status TEXT,
  comment TEXT
);
CREATE INDEX IF NOT EXISTS idx_rcp_history ON repeat_client_plan_history(client_key, month, changed_at DESC);

-- Навчання: адмін (КВП) будує структуру папок і розміщує матеріали (відео через
-- embed-URL YouTube/Vimeo/пряме, завантажені файли, посилання, текст). Читають
-- усі автентифіковані. Файли — у `uploads/../training` (поза публічним static).
CREATE TABLE IF NOT EXISTS training_folders (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES training_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_folders_parent ON training_folders(parent_id);

CREATE TABLE IF NOT EXISTS training_materials (
  id SERIAL PRIMARY KEY,
  folder_id INTEGER REFERENCES training_folders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'video_embed' | 'file' | 'link' | 'text'
  url TEXT,                       -- embed/link URL
  stored_name TEXT,               -- завантажений файл
  mime TEXT,
  size_bytes BIGINT,
  content TEXT,                   -- опис / текстовий матеріал
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_materials_folder ON training_materials(folder_id);

-- Нічна авто-звірка даних із CRM: джоб рахує інваріанти-запобіжники (частка
-- незамаплених статусів, дублі активних менеджерів, свіжість синку, внутрішня
-- узгодженість грошей) і зберігає останній результат. Якщо є попередження —
-- підсвічується в /api/health і створюється задача адміну. Один рядок (id=1).
CREATE TABLE IF NOT EXISTS data_check_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  warnings INTEGER NOT NULL DEFAULT 0,
  checks JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT data_check_singleton CHECK (id = 1)
);

-- «Перший дотик»: аналіз першого дзвінка ад-ліда AI-ботом (my-bot, транскрипція
-- Groq Whisper → LLM визначає, чи озвучено ціну). Джерело — аркуш «Перший дотик»
-- Google-таблиці (той самий файл, що й лідоген-реєстр). Синкається щопівгодини
-- (TRUNCATE+insert). Показник «Озвучено ціну в перший дотик» рахується звідси.
CREATE TABLE IF NOT EXISTS first_touch_analysis (
  lead_id BIGINT PRIMARY KEY,
  analyzed_at DATE NOT NULL,
  price_voiced BOOLEAN NOT NULL DEFAULT false,
  objections_handled BOOLEAN NOT NULL DEFAULT false,
  about_transport TEXT,
  manager_name TEXT,
  team_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_first_touch_date ON first_touch_analysis(analyzed_at);

-- Розділ «Статистики» — довгий (EAV) формат: одна метрика на рядок, бо набір
-- показників різний по відділах. Джерело правди по структурі — catalog.ts.
-- period_start: R1 = 1-ше число місяця / ПОНЕДІЛОК тижня (у листі тиждень = неділя
-- → мінус 6 днів). team_lead: NULL = зведення по відділу; R2 «самостійні»→«Шевчук Назар».
-- source: 'auto' (перерахунок із CRM) | 'manual' (ручний ввід) | 'imported' (одноразовий
-- імпорт історії з Google-таблиці). Деталі — docs/STATISTICS_SPEC.md §0-БІС.
CREATE TABLE IF NOT EXISTS statistics_values (
  id BIGSERIAL PRIMARY KEY,
  department TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('month','week')),
  period_start DATE NOT NULL,
  team_lead TEXT,
  metric_key TEXT NOT NULL,
  value NUMERIC,
  source TEXT NOT NULL CHECK (source IN ('auto','manual','imported')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
-- COALESCE у ключі: team_lead IS NULL і '' трактуються однаково для унікальності.
CREATE UNIQUE INDEX IF NOT EXISTS uq_statistics_values
  ON statistics_values(department, period_type, period_start, COALESCE(team_lead,''), metric_key);
CREATE INDEX IF NOT EXISTS idx_statistics_values_lookup
  ON statistics_values(department, period_type, period_start);

-- Вкладка «Статистики» (діаграми): історія з гугл-таблиці (source='sheet') + ручні
-- точки (source='manual', бюджети/тендери тощо). CRM-ера (≥ шов 2026-07-01) для CRM-able
-- метрик рахується LIVE ядром і ТУТ НЕ зберігається (див. routes/statisticsSeries.ts).
-- Окрема від statistics_values (депстат) — інше призначення, per-scope + per-manager.
CREATE TABLE IF NOT EXISTS stats_series (
  id BIGSERIAL PRIMARY KEY,
  block TEXT NOT NULL,                 -- sales|marketing|logistics|intl|tenders|lgintl|finance|hr
  metric_key TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('company','team_lead','unit')),
  scope_key TEXT NOT NULL,             -- стабільний ключ: team_id (текст) для живих команд; назва — для історичних/unit/company
  scope_name TEXT NOT NULL,            -- показова назва
  granularity TEXT NOT NULL CHECK (granularity IN ('month','week')),
  period_date DATE NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sheet','manual')),
  entered_by INT,                      -- managers.id для source='manual' (аудит)
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stats_series
  ON stats_series(metric_key, scope_type, scope_key, granularity, period_date, source);
CREATE INDEX IF NOT EXISTS idx_stats_series_lookup
  ON stats_series(block, metric_key, granularity, period_date);

-- §3b словника (13.07.2026): adSources живе В БД, а не в дефолтах коду.
-- Мовчазний мердж дефолтів прибрано з getSettings(); зміни списку журналюються.
CREATE TABLE IF NOT EXISTS ad_sources_log (
  id BIGSERIAL PRIMARY KEY,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by TEXT,
  old_list JSONB,
  new_list JSONB NOT NULL
);
-- Разовий сид: якщо adSources ще не збережений у налаштуваннях — записуємо
-- поточний (колишній дефолтний) список явно.
INSERT INTO app_settings (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;
UPDATE app_settings SET data = data || '{"adSources":["uts.ua","Дзвінок з uts.ua","Callback з uts.ua","yalogist.com.ua","Дзвінок з yalogist.com.ua","Callback з yalogist.com.ua"]}'::jsonb
 WHERE id = 1 AND NOT (data ? 'adSources');
INSERT INTO ad_sources_log (changed_by, old_list, new_list)
 SELECT 'migration:seed', NULL, data->'adSources' FROM app_settings WHERE id = 1
   AND NOT EXISTS (SELECT 1 FROM ad_sources_log);

-- КРОК 4 (Звірка): результати нічної реконсиляції наше↔Kommo + інваріант цілісності.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  months INT NOT NULL,
  rows_checked INT NOT NULL DEFAULT 0,
  rows_over_threshold INT NOT NULL DEFAULT 0,   -- скільки (місяць×менеджер) перевищили 0.5%
  max_delta_pct NUMERIC,                        -- найбільша |дельта| по виручці
  integrity_orphans INT NOT NULL DEFAULT 0,     -- deal_id з deal_stage_events без угоди в deals
  ok BOOLEAN NOT NULL,
  worst_json JSONB,                             -- топ розбіжностей для дебагу
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_ran_at ON reconciliation_runs(ran_at DESC);
-- КРОК 4: третій рівень звірки (money.ts ↔ deals) — дашборд.
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS dashboard_over INT NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS dashboard_max_delta NUMERIC;
-- AUTO-HEAL: скільки дормантних угод (виграні в Kommo, відсутні в deals) дотягнуто
-- цієї ночі. ОБОВ'ЯЗКОВО логувати — інакше авто-хіл ховає дірку за зеленою звіркою.
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS healed_count INT NOT NULL DEFAULT 0;

-- КРОК 5 (варіант A): історія прив'язки менеджера до команди. Kommo НЕ веде історію
-- зміни групи менеджера (events API — лише сутності; /users віддає тільки поточну
-- групу) → за минуле відновити неможливо. З 14.07.2026 пишемо снапшот САМІ: рядок
-- з'являється при КОЖНІЙ зміні team_id менеджера в синку (і при першій появі менеджера).
-- Реконструкція команди на дату D: останній рядок з changed_at <= D. До baseline —
-- лишається поточна прив'язка (відомий артефакт, позначений у UI командного розрізу).
CREATE TABLE IF NOT EXISTS manager_team_history (
  id BIGSERIAL PRIMARY KEY,
  manager_id INT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  team_id INT,                       -- NULL = без команди
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mth_manager_time ON manager_team_history(manager_id, changed_at DESC);
-- Baseline поточних прив'язок — РАЗ (guard: лише коли таблиця порожня).
INSERT INTO manager_team_history (manager_id, team_id, changed_at)
SELECT id, team_id, now() FROM managers
WHERE NOT EXISTS (SELECT 1 FROM manager_team_history);

-- КРОК 5: замок важких Kommo-джоб із heartbeat. Замість глобального лімітера —
-- поки біжить важка джоба (звірка / бекфіл / auto-heal), syncKommo пропускає прохід,
-- щоб важкий 12-міс потік не наклався на 30-хв синк і разом не перевищив ліміт Kommo.
-- ⚠️ У БД (не in-process): важкі джоби часто біжать ОКРЕМИМ процесом (nohup), тож
-- лічильник у пам'яті Express їх би не побачив. ⚠️ Heartbeat (раз на 30с): якщо джоба
-- впала — замок протухає (>2 хв) і знімається САМ. Ні вічної паузи (як забутий
-- KOMMO_PAUSED), ні сліпоти до зовнішніх процесів.
CREATE TABLE IF NOT EXISTS job_locks (
  name TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 🔁 Самоперевірка Формули A прогнозу (стоп-критерій формули): по завершенні
-- місяця reconcileNightly реконструює «прогноз@17» (та сама методологія, що
-- бектест: статус-на-T + повна зона + трейл-добір) і порівнює з реальним фіналом.
-- PK ym → рахується РАЗ на місяць (ідемпотентно). |error_pct| > 10 → Telegram-алерт.
CREATE TABLE IF NOT EXISTS projection_backtest (
  ym TEXT PRIMARY KEY,               -- 'YYYY-MM' (завершений місяць)
  fact_at17 NUMERIC NOT NULL,        -- реконструйований факт на 17-те (142+етап9 по подіях)
  zone_at17 NUMERIC NOT NULL,        -- повна грошова зона на 17-те (за статусом)
  dobir NUMERIC NOT NULL,            -- трейл-3м добір (created>17 & closed same month)
  forecast NUMERIC NOT NULL,         -- fact_at17 + zone_at17 + dobir
  final NUMERIC NOT NULL,            -- реальний фінал місяця (success по closed_at)
  error_pct NUMERIC,                 -- (forecast-final)/final×100; NULL якщо final=0
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── «ФОРМУВАННЯ ПЛАНУ» (двоетапне погодження, окремо від сакрального `plans`) ──
-- Тімлід формує пропозицію плану по кожному менеджеру своєї команди (draft → submitted),
-- КВП/адмін затверджує (approved) або повертає (returned) з коментарем. У сакральний
-- `plans` (metric='payment_amount') число потрапляє ЛИШЕ на approve. `plans` не має місця
-- під workflow-метадані (лише manager_id+plan_date+metric+value), тож стан живе тут.
-- Прецедент — `repeat_client_plans` (submit→approve), але тут 4 стани (+ returned/return_comment)
-- і рольова модель ІНША: подає тімлід, затверджує/повертає ЛИШЕ адмін.
CREATE TABLE IF NOT EXISTS plan_formation (
  id SERIAL PRIMARY KEY,
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  month DATE NOT NULL,                              -- 'YYYY-MM-01' (target-місяць)
  metric TEXT NOT NULL DEFAULT 'payment_amount',    -- наразі лише грошовий місячний план
  proposed_value NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','returned')),
  comment TEXT,                                     -- обґрунтування тімліда
  return_comment TEXT,                              -- коментар КВП при поверненні
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  decided_by INTEGER REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, month, metric)
);
CREATE INDEX IF NOT EXISTS idx_plan_formation_month ON plan_formation (month, status);

-- ============================================================================
-- RBAC (Phase 1). Additive, idempotent. Вбудовані ролі = ТОЧНА поточна поведінка.
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
  key           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  built_in      BOOLEAN NOT NULL DEFAULT false,
  data_scope    TEXT NOT NULL DEFAULT 'own' CHECK (data_scope IN ('own','team','company')),
  screen_access JSONB NOT NULL DEFAULT '{}',
  permissions   JSONB NOT NULL DEFAULT '{}',
  cloned_from   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сид 4 вбудованих. screen_access/permissions зберігаємо ЛИШЕ надані ключі=true
-- (відсутність = немає доступу). Значення = дзеркало nav-гейта + серверних 403 сьогодні.
INSERT INTO roles (key,name,built_in,data_scope,screen_access,permissions) VALUES
 ('admin','Адмін',true,'company',
  '{"overview":true,"report":true,"manager-report":true,"kvp":true,"plans":true,"statistics":true,"depstats":true,"teams":true,"managers":true,"reports":true,"loyalty":true,"receivables":true,"leadgen":true,"tasks":true,"duty":true,"oneonone":true,"rates":true,"goals":true,"messenger":true,"news":true,"documents":true,"training":true,"dataquality":true,"feedback":true,"aiwork":true,"settings":true,"bank":true}',
  '{"approve_plans":true,"submit_plans":true,"manage_goals":true,"enter_manual_stats":true,"manage_users":true,"export":true,"view_hidden_payments":true,"manage_bank_hidden":true,"manage_bank_accounts":true}'),
 ('kvp','КВП',true,'company',
  '{"overview":true,"report":true,"manager-report":true,"kvp":true,"plans":true,"statistics":true,"depstats":true,"teams":true,"managers":true,"reports":true,"loyalty":true,"receivables":true,"leadgen":true,"tasks":true,"duty":true,"oneonone":true,"rates":true,"goals":true,"messenger":true,"news":true,"documents":true,"training":true,"dataquality":true,"feedback":true,"aiwork":true,"bank":true}',
  '{"approve_plans":true,"submit_plans":true,"manage_goals":true,"enter_manual_stats":true,"export":true}'),
 ('team_lead','Тімлід',true,'team',
  '{"overview":true,"report":true,"manager-report":true,"plans":true,"statistics":true,"depstats":true,"teams":true,"managers":true,"reports":true,"loyalty":true,"receivables":true,"leadgen":true,"tasks":true,"duty":true,"oneonone":true,"rates":true,"goals":true,"messenger":true,"news":true,"documents":true,"training":true,"dataquality":true,"feedback":true,"bank":true}',
  '{"submit_plans":true,"manage_goals":true,"export":true}'),
 ('manager','Менеджер',true,'own',
  '{"overview":true,"report":true,"manager-report":true,"statistics":true,"depstats":true,"reports":true,"loyalty":true,"receivables":true,"leadgen":true,"tasks":true,"duty":true,"rates":true,"messenger":true,"news":true,"documents":true,"training":true,"feedback":true,"bank":true}',
  '{"export":true}')
ON CONFLICT (key) DO NOTHING;

-- Override-роль: панель-owned, синк її НІКОЛИ не чіпає. Ефективна роль = COALESCE(role_override, role).
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_override TEXT REFERENCES roles(key);

-- Backfill = НУЛЬ змін доступу:
--  1) кожен теперішній admin → role_override='admin' (синк далі веде users.role, але не адмінство).
UPDATE users SET role_override = 'admin' WHERE role = 'admin' AND role_override IS NULL;
--  2) замінюємо хардкод TEAM_LEAD_OVERRIDES={3379102} (Яцик) на кероване поле,
--     щоб видалення хардкоду з синку не зняло його team_lead.
UPDATE users SET role_override = 'team_lead'
 WHERE role_override IS NULL
   AND manager_id IN (SELECT id FROM managers WHERE kommo_user_id = 3379102);

-- Причина/дата деактивації (для Архіву). Хто саме — окремий аудит.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT; -- ПІБ для РУЧНИХ юзерів (CRM-менеджерам ПІБ береться з managers.name)

-- Паролі → хеш-онлі: гасимо плейнтекст (колонку лишаємо, більше не наповнюємо/не показуємо).
UPDATE users SET initial_password = NULL WHERE initial_password IS NOT NULL;

CREATE TABLE IF NOT EXISTS access_audit (
  id            SERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id INTEGER REFERENCES users(id),
  actor_email   TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL CHECK (target_type IN ('user','role')),
  target_id     TEXT NOT NULL,
  target_label  TEXT,
  details       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON access_audit(at DESC);

-- ============================================================================
-- ВИПИСКА (банківські виписки). Окремо від CRM-метрик. Фаза 1.
-- ============================================================================
CREATE TABLE IF NOT EXISTS bank_accounts (
  id            SERIAL PRIMARY KEY,
  company       TEXT NOT NULL CHECK (company IN ('uts','automuv','fop_privat','fop_mono')),
  bank          TEXT NOT NULL CHECK (bank IN ('mono','privat')),
  label         TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'UAH',
  external_account_id TEXT,               -- id/iban рахунку в банк-API (мапінг tx)
  is_active     BOOLEAN NOT NULL DEFAULT true,
  legal_name    TEXT,                     -- редаговані ПУБЛІЧНІ реквізити:
  edrpou_ipn    TEXT,
  iban          TEXT,
  bank_name     TEXT,
  mfo           TEXT,
  purpose       TEXT,
  env_key_name  TEXT,                     -- назва env-змінної з ключем; НЕ сам ключ
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES bank_accounts(id),
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  external_tx_id  TEXT NOT NULL UNIQUE,   -- ідемпотентність upsert
  booked_at       TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  counterparty_name TEXT,
  counterparty_iban TEXT,
  purpose         TEXT,
  amount          NUMERIC NOT NULL,       -- signed: + надходження, − списання (у валюті рахунку)
  currency        TEXT NOT NULL DEFAULT 'UAH',
  fx_rate         NUMERIC,                -- UAH за 1 одиницю валюти (=1 для UAH)
  amount_uah      NUMERIC,                -- amount * fx_rate
  unmatched_account BOOLEAN NOT NULL DEFAULT false,
  raw_json        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_acc_date ON bank_transactions(account_id, booked_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_tx_dir_date ON bank_transactions(direction, booked_at DESC);

CREATE TABLE IF NOT EXISTS bank_hidden_payees (
  id          SERIAL PRIMARY KEY,
  pattern     TEXT NOT NULL,
  match_type  TEXT NOT NULL CHECK (match_type IN ('exact','glob')),
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Курс НБУ на дату (фолбек, коли банк-API не дав курсу): UAH за 1 одиницю валюти.
CREATE TABLE IF NOT EXISTS fx_rates_daily (
  rate_date  DATE NOT NULL,
  currency   TEXT NOT NULL,
  rate       NUMERIC NOT NULL,           -- UAH за 1 одиницю
  source     TEXT NOT NULL DEFAULT 'nbu',
  PRIMARY KEY (rate_date, currency)
);

-- RBAC-міграція (ідемпотентно): вкладку «bank» бачать УСІ ролі (built-in + кастомні, напр. hr).
UPDATE roles SET screen_access = screen_access || '{"bank":true}'::jsonb
  WHERE NOT (screen_access ? 'bank');
-- 3 банк-права — лише admin за замовчуванням (адмін може видати іншим тумблером у панелі).
UPDATE roles SET permissions = permissions ||
  '{"view_hidden_payments":true,"manage_bank_hidden":true,"manage_bank_accounts":true}'::jsonb
  WHERE key = 'admin';

-- Баланси рахунків: останній залишок з банк-API (mono client-info / privat closing-balance),
-- оновлюється на циклі синку. Ідемпотентно; наявні рахунки не чіпаємо.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS balance_amount     NUMERIC;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS balance_currency   TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ;
-- Розширені (публічні) реквізити компаній — для картки «Реквізити» (бачать усі ролі).
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS vat_ipn       TEXT; -- ІПН (платник ПДВ)
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS legal_address TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS director      TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS bank_edrpou   TEXT; -- ЄДРПОУ банку

-- Право «бачити баланси» — ЛИШЕ вбудованій ролі admin; решті доступ НЕ змінюємо.
UPDATE roles SET permissions = permissions || '{"view_balances":true}'::jsonb WHERE key = 'admin';
-- Право «бачити підсумки виписки» (агрегати надходжень/платежів) — ЛИШЕ admin; решті не чіпаємо.
UPDATE roles SET permissions = permissions || '{"view_bank_totals":true}'::jsonb WHERE key = 'admin';

-- Право «кешфлоу» — default у admin. Роль «Фінансист» (РЕДАГОВАНА, admin може тюнити) — доступ до
-- Виписки + фінансові права, БЕЗ manage_users/manage_bank_*/view_hidden. Ідемпотентно (ON CONFLICT
-- DO NOTHING — не перетираємо admin-правки ролі); наявний доступ інших не чіпаємо.
UPDATE roles SET permissions = permissions || '{"view_cashflow":true}'::jsonb WHERE key = 'admin';
INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions)
VALUES ('financier', 'Фінансист', false, 'company', '{"bank":true}'::jsonb,
        '{"view_cashflow":true,"view_bank_totals":true,"view_balances":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Роль «HR» (РЕДАГОВАНА): company-scope + доступ до Задачника й «Ван-ту-ван».
-- ⚠️ data_scope МАЄ бути 'company' (не дефолтний 'own'): при 'own' scope-clamp у middleware
-- трактує роль як 'manager' → 1Х1 (manager-blocker oneOnOnes.ts) і створення задачі падають 403
-- попри увімкнені екрани. Company-scope проходить обидва гейти (як kvp/financier). Доступ
-- відкриває САМЕ екран (tab-гейт tasks/oneonone) — вимкнеш екран, сервер закриє. Ідемпотентно
-- (ON CONFLICT DO NOTHING — не перетираємо наявну роль/admin-правки); решту екранів/прав admin
-- вмикає тумблером у панелі (не відкриваємо ширше, ніж треба для задач + 1Х1).
INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions)
VALUES ('hr', 'HR', false, 'company', '{"tasks":true,"oneonone":true}'::jsonb, '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 1×1 ПЕРЕРОБКА · права + ролі СЕО/Опер.директор ──────────────────────────
-- view_all_1x1  = НАСКРІЗНИЙ доступ до 1×1 (усі типи/люди/історія/аналітика), поза conductor-скоупом.
-- edit_1x1_forms = редагувати набори питань 1×1 у Налаштуваннях (створює нову версію форми).
-- HR отримує обидва (додаємо РАЗ, якщо ще нема — не перетираємо ручні правки адміна).
UPDATE roles SET permissions = permissions || '{"view_all_1x1":true}'::jsonb
  WHERE key = 'hr' AND NOT (permissions ? 'view_all_1x1');
UPDATE roles SET permissions = permissions || '{"edit_1x1_forms":true}'::jsonb
  WHERE key = 'hr' AND NOT (permissions ? 'edit_1x1_forms');

-- Ролі СЕО / Опер.директор — company-scope, admin-суперсет (усі екрани + admin-права),
-- ПЛЮС наскрізний перегляд/редагування 1×1. Суперсет — щоб апгрейд наявних адмін-акаунтів
-- (utservice3, kriptokoval) НЕ забирав можливостей. Ідемпотентно (ON CONFLICT DO NOTHING).
INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions)
SELECT k.key, k.name, false, 'company', r.screen_access,
       r.permissions || '{"view_all_1x1":true,"edit_1x1_forms":true}'::jsonb
FROM (VALUES ('ceo','СЕО'), ('opdir','Операційний директор')) AS k(key,name)
CROSS JOIN (SELECT screen_access, permissions FROM roles WHERE key='admin') r
ON CONFLICT (key) DO NOTHING;

-- Апгрейд власників у ролі СЕО/ОД (лише якщо зараз чистий 'admin' → суперсет, без втрати прав).
UPDATE users SET role_override = 'opdir' WHERE email = 'utservice3@gmail.com'  AND role_override = 'admin';
UPDATE users SET role_override = 'ceo'   WHERE email = 'kriptokoval@gmail.com' AND role_override = 'admin';

-- Службові збори банку (комісії) — позначаємо, щоб не показувати серед вихідних платежів.
-- Патерни: counterparty_name містить «ЗА ДЕБЕТУВАННЯ РАХУНК…»; purpose починається з «Комісія…».
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS is_bank_fee BOOLEAN NOT NULL DEFAULT false;
UPDATE bank_transactions SET is_bank_fee = true
  WHERE is_bank_fee = false AND (
    counterparty_name ILIKE '%ЗА ДЕБЕТУВАННЯ РАХУНК%'
    OR btrim(coalesce(purpose, '')) ILIKE 'Комісія%'
  );

-- access_audit — розширюємо типи цілей на банк-обʼєкти.
ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_target_type_check;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_target_type_check
  CHECK (target_type IN ('user','role','bank_account','bank_payee'));

-- Сид 4 відомих рахунків (лише структурні поля + env_key_name; реквізити адмін заповнює в
-- панелі). Bootstrap: сидимо ЛИШЕ коли таблиця порожня → ідемпотентно, не дублює на ре-міграції
-- і не воскрешає видалені/змінені адміном рахунки.
-- legal_name сидимо лише для ФОП (одна фізособа на обидва рахунки); ТОВ лишаємо NULL —
-- адмін заповнить у панелі. Решта реквізитів (ЄДРПОУ/IBAN/банк/МФО/призначення) — теж у панелі.
INSERT INTO bank_accounts (company, bank, label, currency, env_key_name, is_active, legal_name)
SELECT * FROM (VALUES
 ('uts','privat','ТОВ ЮТС','UAH','PRIVAT_TOKEN_UTS',true,NULL),
 ('automuv','privat','ТОВ Автомув','UAH','PRIVAT_TOKEN_AUTOMUV',true,NULL),
 ('fop_privat','privat','ФОП Беспятчук (Приват)','UAH','PRIVAT_TOKEN_FOP',true,'ФОП Беспятчук Сергій Степанович'),
 ('fop_mono','mono','ФОП Беспятчук (Моно)','UAH','MONO_TOKEN_FOP',true,'ФОП Беспятчук Сергій Степанович')
) AS v(company, bank, label, currency, env_key_name, is_active, legal_name)
WHERE NOT EXISTS (SELECT 1 FROM bank_accounts);

-- ─────────────────────────── Трекер часу (окрема підсистема) ───────────────────────────
-- Власна авторизація (device-токен), НЕ JWT. Банк/виписку не чіпає.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tracker_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS tracker_devices (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  manager_id    INTEGER REFERENCES managers(id),
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256(deviceToken); сам токен ніде не зберігаємо
  platform      TEXT NOT NULL,
  hostname      TEXT,
  agent_version TEXT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracker_intervals (
  id           BIGSERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES tracker_devices(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  manager_id   INTEGER REFERENCES managers(id),
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','idle')),
  app          TEXT,
  window_title TEXT,
  input_events INTEGER,
  UNIQUE (device_id, started_at)             -- дедуплікація heartbeat-батчів
);
CREATE INDEX IF NOT EXISTS idx_tracker_intervals_user_time ON tracker_intervals (user_id, started_at);

-- Одноразове ввімкнення: усі з ефективною роллю manager + Дарʼя (utservice62). Власника/адмінів — НІ.
UPDATE users SET tracker_enabled = true WHERE COALESCE(role_override, role) = 'manager';
UPDATE users SET tracker_enabled = true WHERE lower(email) = 'utservice62@gmail.com';
