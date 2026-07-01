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

-- Monthly snapshot of "carried-over" deals: the value of deals still in
-- progress (approved→invoiced→payment received, NOT yet closed as Успішна) as
-- of the 1st of the month. Captured once per month (fixed figure).
CREATE TABLE IF NOT EXISTS monthly_carryover (
  month DATE PRIMARY KEY,
  amount NUMERIC NOT NULL DEFAULT 0,
  deals INTEGER NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
