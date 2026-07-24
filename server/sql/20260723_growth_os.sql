-- Growth OS Phase 2: founder-owned persistent operating data.
BEGIN;

CREATE SCHEMA IF NOT EXISTS growth_os;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION growth_os.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS growth_os.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES data_room.users(id),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/London',
  preferred_working_days jsonb NOT NULL DEFAULT '["monday","tuesday","wednesday","thursday","friday"]',
  default_platforms jsonb NOT NULL DEFAULT '[]',
  default_content_duration integer,
  notification_preferences jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id)
);

CREATE TABLE IF NOT EXISTS growth_os.strategy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES growth_os.workspaces(id) ON DELETE CASCADE,
  objective text, target_audience text, core_message text, customer_problem text,
  brand_principles jsonb NOT NULL DEFAULT '[]', content_pillars jsonb NOT NULL DEFAULT '[]',
  success_metrics jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.sprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  seed_key text,
  name text NOT NULL, objective text, description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','archived')),
  start_date date, end_date date, target_metrics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_one_active_sprint ON growth_os.sprints(workspace_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS growth_os.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  seed_key text,
  sprint_id uuid REFERENCES growth_os.sprints(id) ON DELETE SET NULL,
  name text NOT NULL, objective text, audience text, core_message text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparing','active','paused','completed','archived')),
  start_date date, end_date date, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.daily_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  seed_key text,
  sprint_id uuid REFERENCES growth_os.sprints(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  title text NOT NULL, description text, reason text, expected_outcome text,
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes >= 0),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  mission_date date NOT NULL, status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','skipped')),
  completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.customer_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  seed_key text,
  question text NOT NULL, theme text, source text,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','used','archived')),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  sprint_id uuid REFERENCES growth_os.sprints(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  title text NOT NULL, content_type text NOT NULL, platform text, pillar text,
  customer_question_id uuid REFERENCES growth_os.customer_questions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','research','talking_points','script','record','edit','scheduled','published','results','repurpose','archived')),
  hook text, research_notes text, talking_points text, script text, caption text, call_to_action text,
  scheduled_at timestamptz, published_at timestamptz, external_post_url text,
  result_summary text, repurpose_notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('tiktok','instagram','linkedin','website','waitlist','combined')),
  snapshot_date date NOT NULL, followers bigint, reach bigint, impressions bigint, profile_visits bigint,
  engagement_count bigint, engagement_rate numeric, video_views bigint, average_watch_time_seconds numeric,
  shares bigint, saves bigint, comments bigint, posts_published bigint, waitlist_signups_attributed bigint,
  notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, snapshot_date)
);

CREATE TABLE IF NOT EXISTS growth_os.goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  sprint_id uuid REFERENCES growth_os.sprints(id) ON DELETE SET NULL,
  metric_key text NOT NULL, label text NOT NULL, starting_value numeric, target_value numeric NOT NULL, current_value numeric,
  start_date date, target_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','missed','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  sprint_id uuid REFERENCES growth_os.sprints(id) ON DELETE SET NULL,
  category text NOT NULL, title text NOT NULL, evidence text, recommended_decision text,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','calculated')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','actioned','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.calendar_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  content_item_id uuid REFERENCES growth_os.content_items(id) ON DELETE SET NULL,
  title text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('filming','editing','publishing','campaign','review','newsletter','community')),
  starts_at timestamptz NOT NULL, ends_at timestamptz, platform text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled')),
  notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  filename text NOT NULL, display_name text NOT NULL, asset_type text NOT NULL, mime_type text,
  storage_key text, thumbnail_reference text, tags jsonb NOT NULL DEFAULT '[]',
  approved_for_use boolean NOT NULL DEFAULT false, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Repair only the additive seed identity required by this migration when a
-- partial Growth OS schema already exists. Do not alter other definitions.
ALTER TABLE growth_os.sprints ADD COLUMN IF NOT EXISTS seed_key text;
ALTER TABLE growth_os.campaigns ADD COLUMN IF NOT EXISTS seed_key text;
ALTER TABLE growth_os.daily_missions ADD COLUMN IF NOT EXISTS seed_key text;
ALTER TABLE growth_os.customer_questions ADD COLUMN IF NOT EXISTS seed_key text;

DO $$
DECLARE
  target record;
  actual_type text;
  workspace_id_type text;
  constraint_definition text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('sprints', 'growth_sprints_workspace_seed_key_key'),
      ('campaigns', 'growth_campaigns_workspace_seed_key_key'),
      ('daily_missions', 'growth_daily_missions_workspace_seed_key_key'),
      ('customer_questions', 'growth_customer_questions_workspace_seed_key_key')
    ) AS required(table_name, constraint_name)
  LOOP
    SELECT c.data_type INTO actual_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'growth_os'
      AND c.table_name = target.table_name
      AND c.column_name = 'seed_key';

    IF actual_type IS DISTINCT FROM 'text' THEN
      RAISE EXCEPTION 'growth_os.%.seed_key must be text; found %',
        target.table_name, COALESCE(actual_type, 'missing');
    END IF;

    SELECT c.data_type INTO workspace_id_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'growth_os'
      AND c.table_name = target.table_name
      AND c.column_name = 'workspace_id';

    IF workspace_id_type IS DISTINCT FROM 'uuid' THEN
      RAISE EXCEPTION 'growth_os.%.workspace_id must be uuid; found %',
        target.table_name, COALESCE(workspace_id_type, 'missing');
    END IF;

    SELECT pg_get_constraintdef(constraint_record.oid)
    INTO constraint_definition
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid =
      format('growth_os.%I', target.table_name)::regclass
      AND constraint_record.conname = target.constraint_name;

    IF constraint_definition IS NULL THEN
      EXECUTE format(
        'ALTER TABLE growth_os.%I ADD CONSTRAINT %I UNIQUE (workspace_id, seed_key)',
        target.table_name,
        target.constraint_name
      );
    ELSIF constraint_definition <> 'UNIQUE (workspace_id, seed_key)' THEN
      RAISE EXCEPTION 'Constraint growth_os.%.% is incompatible: %',
        target.table_name, target.constraint_name, constraint_definition;
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS growth_sprints_workspace_status ON growth_os.sprints(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_campaigns_workspace_status ON growth_os.campaigns(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_campaigns_sprint ON growth_os.campaigns(sprint_id);
CREATE INDEX IF NOT EXISTS growth_missions_workspace_status_date ON growth_os.daily_missions(workspace_id,status,mission_date);
CREATE INDEX IF NOT EXISTS growth_missions_sprint ON growth_os.daily_missions(sprint_id);
CREATE INDEX IF NOT EXISTS growth_missions_campaign ON growth_os.daily_missions(campaign_id);
CREATE INDEX IF NOT EXISTS growth_content_workspace_status ON growth_os.content_items(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_content_sprint ON growth_os.content_items(sprint_id);
CREATE INDEX IF NOT EXISTS growth_content_campaign ON growth_os.content_items(campaign_id);
CREATE INDEX IF NOT EXISTS growth_content_scheduled ON growth_os.content_items(scheduled_at);
CREATE INDEX IF NOT EXISTS growth_content_published ON growth_os.content_items(published_at);
CREATE INDEX IF NOT EXISTS growth_questions_workspace_status ON growth_os.customer_questions(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_metrics_workspace_date ON growth_os.metric_snapshots(workspace_id,snapshot_date DESC);
CREATE INDEX IF NOT EXISTS growth_goals_workspace_status ON growth_os.goals(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_goals_sprint ON growth_os.goals(sprint_id);
CREATE INDEX IF NOT EXISTS growth_insights_workspace_status ON growth_os.insights(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_insights_sprint ON growth_os.insights(sprint_id);
CREATE INDEX IF NOT EXISTS growth_calendar_workspace_starts ON growth_os.calendar_entries(workspace_id,starts_at);
CREATE INDEX IF NOT EXISTS growth_media_workspace ON growth_os.media_assets(workspace_id);

DO $$
DECLARE founder_id uuid; workspace_uuid uuid; sprint_uuid uuid; campaign_uuid uuid;
BEGIN
  SELECT id INTO founder_id FROM data_room.users WHERE lower(email) = 'emmamendez07@gmail.com' LIMIT 1;
  IF founder_id IS NULL THEN
    RAISE NOTICE 'Growth OS schema created; founder seed data skipped because the expected founder user does not exist';
    RETURN;
  END IF;

  INSERT INTO growth_os.workspaces(owner_user_id,name,timezone)
  VALUES(founder_id,'KLPS Growth OS','Europe/London')
  ON CONFLICT(owner_user_id) DO NOTHING;

  SELECT id INTO workspace_uuid
  FROM growth_os.workspaces
  WHERE owner_user_id = founder_id;

  INSERT INTO growth_os.strategy(workspace_id,objective,target_audience,core_message,customer_problem,brand_principles,content_pillars,success_metrics)
  VALUES(workspace_uuid,'Stop guessing and build a repeatable evidence-led growth system',NULL,NULL,NULL,
    '["Evidence before claims","Clarity over hype","Founder-led learning"]',
    '["Customer questions","Founder journey","Evidence and learning"]','[]')
  ON CONFLICT(workspace_id) DO NOTHING;

  -- Adopt exact records created by the pre-seed-key version of this migration.
  -- Select one stable oldest match and never overwrite normal founder records.
  UPDATE growth_os.sprints
  SET seed_key = 'initial-operation-stop-guessing'
  WHERE id = (
    SELECT id FROM growth_os.sprints
    WHERE workspace_id = workspace_uuid
      AND seed_key IS NULL
      AND name = 'Operation Stop Guessing'
      AND objective = 'Replace assumptions with a consistent publishing and learning rhythm'
    ORDER BY created_at, id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM growth_os.sprints
    WHERE workspace_id = workspace_uuid
      AND seed_key = 'initial-operation-stop-guessing'
  );

  INSERT INTO growth_os.sprints(workspace_id,seed_key,name,objective,status,start_date,target_metrics)
  VALUES(
    workspace_uuid,
    'initial-operation-stop-guessing',
    'Operation Stop Guessing',
    'Replace assumptions with a consistent publishing and learning rhythm',
    CASE WHEN EXISTS (
      SELECT 1 FROM growth_os.sprints
      WHERE workspace_id = workspace_uuid AND status = 'active'
    ) THEN 'draft' ELSE 'active' END,
    DATE '2026-07-23',
    '{}'
  )
  ON CONFLICT(workspace_id,seed_key) DO NOTHING;

  SELECT id INTO sprint_uuid
  FROM growth_os.sprints
  WHERE workspace_id = workspace_uuid
    AND seed_key = 'initial-operation-stop-guessing';

  UPDATE growth_os.campaigns
  SET seed_key = 'initial-founder-led-education'
  WHERE id = (
    SELECT id FROM growth_os.campaigns
    WHERE workspace_id = workspace_uuid
      AND seed_key IS NULL
      AND name = 'Operation Stop Guessing'
      AND objective = 'Turn customer questions into useful founder-led content'
    ORDER BY created_at, id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM growth_os.campaigns
    WHERE workspace_id = workspace_uuid
      AND seed_key = 'initial-founder-led-education'
  );

  INSERT INTO growth_os.campaigns(workspace_id,seed_key,sprint_id,name,objective,status,start_date)
  VALUES(
    workspace_uuid,
    'initial-founder-led-education',
    sprint_uuid,
    'Founder-led Education',
    'Turn customer questions into useful founder-led content',
    'active',
    DATE '2026-07-23'
  )
  ON CONFLICT(workspace_id,seed_key) DO NOTHING;

  SELECT id INTO campaign_uuid
  FROM growth_os.campaigns
  WHERE workspace_id = workspace_uuid
    AND seed_key = 'initial-founder-led-education';

  UPDATE growth_os.customer_questions
  SET seed_key = 'initial-body-change-question'
  WHERE id = (
    SELECT id FROM growth_os.customer_questions
    WHERE workspace_id = workspace_uuid
      AND seed_key IS NULL
      AND question = 'Why does my body change every week?'
      AND source = 'Founder research'
    ORDER BY created_at, id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM growth_os.customer_questions
    WHERE workspace_id = workspace_uuid
      AND seed_key = 'initial-body-change-question'
  );

  INSERT INTO growth_os.customer_questions(workspace_id,seed_key,question,theme,source,priority,status)
  VALUES(
    workspace_uuid,
    'initial-body-change-question',
    'Why does my body change every week?',
    'Body changes',
    'Founder research',
    'high',
    'approved'
  )
  ON CONFLICT(workspace_id,seed_key) DO NOTHING;

  -- This is a stable starter record, not an automatically recurring mission.
  -- The service layer creates actual dated daily missions when requested.
  UPDATE growth_os.daily_missions
  SET seed_key = 'initial-first-mission'
  WHERE id = (
    SELECT id FROM growth_os.daily_missions
    WHERE workspace_id = workspace_uuid
      AND seed_key IS NULL
      AND title = 'Turn one customer question into content'
      AND reason = 'Build from a real customer need.'
    ORDER BY created_at, id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM growth_os.daily_missions
    WHERE workspace_id = workspace_uuid
      AND seed_key = 'initial-first-mission'
  );

  INSERT INTO growth_os.daily_missions(
    workspace_id,seed_key,sprint_id,campaign_id,title,description,reason,
    expected_outcome,estimated_minutes,priority,mission_date,status
  )
  VALUES(
    workspace_uuid,
    'initial-first-mission',
    sprint_uuid,
    campaign_uuid,
    'Turn one customer question into content',
    'Choose an approved customer question and develop the next content item.',
    'Build from a real customer need.',
    'One useful content item ready to progress.',
    30,
    'high',
    DATE '2026-07-23',
    'planned'
  )
  ON CONFLICT(workspace_id,seed_key) DO NOTHING;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspaces','strategy','sprints','campaigns','daily_missions','customer_questions','content_items','metric_snapshots','goals','insights','calendar_entries','media_assets']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON growth_os.%I', table_name);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON growth_os.%I FOR EACH ROW EXECUTE FUNCTION growth_os.set_updated_at()', table_name);
  END LOOP;
END $$;

COMMIT;
