CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS managers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  kommo_user_id BIGINT UNIQUE,
  is_team_lead BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE managers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'team_lead', 'manager')),
  manager_id INTEGER REFERENCES managers(id),
  team_id INTEGER REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE managers ADD COLUMN IF NOT EXISTS is_team_lead BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_deals_manager ON deals(manager_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(pipeline_id, status_id);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);

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
