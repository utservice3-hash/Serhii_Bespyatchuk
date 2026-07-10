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

-- Ван-ту-вани (1-on-1): щомісячна зустріч із співробітником. Тімлід проводить
-- зі своєю командою; операційний/КВП (admin) — з тімлідами й бачить усіх.
-- Менеджери 1-on-1 НЕ бачать. answers = { questionKey: {score?:1..10, text?} }.
CREATE TABLE IF NOT EXISTS one_on_ones (
  subject_manager_id INTEGER NOT NULL REFERENCES managers(id),
  month DATE NOT NULL,
  conducted_by INTEGER REFERENCES users(id),
  answers JSONB NOT NULL DEFAULT '{}',
  overall NUMERIC,               -- середнє по scored-відповідях (кеш для статистики)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_manager_id, month)
);
CREATE INDEX IF NOT EXISTS idx_one_on_ones_month ON one_on_ones(month);

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
