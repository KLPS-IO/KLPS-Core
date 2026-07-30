-- Growth OS Phase 4A: secure, provider-neutral social integration foundation.
-- No provider credentials or tokens are seeded by this migration.
BEGIN;

CREATE SCHEMA IF NOT EXISTS growth_os;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE dependency text;
BEGIN
  FOREACH dependency IN ARRAY ARRAY[
    'data_room.users',
    'growth_os.workspaces',
    'growth_os.content_items',
    'growth_os.tracked_links'
  ]
  LOOP
    IF to_regclass(dependency) IS NULL THEN
      RAISE EXCEPTION 'Required relation % does not exist', dependency;
    END IF;
  END LOOP;
  IF to_regprocedure('growth_os.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Required function growth_os.set_updated_at() does not exist';
  END IF;
END $$;

-- Composite keys allow every relationship below to enforce workspace isolation.
CREATE UNIQUE INDEX IF NOT EXISTS growth_content_items_workspace_id_unique
  ON growth_os.content_items(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS growth_tracked_links_workspace_id_unique
  ON growth_os.tracked_links(workspace_id,id);

CREATE TABLE growth_os.social_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('linkedin','facebook','instagram','x','tiktok','snapchat')),
  provider_account_id text,
  provider_account_name text,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connecting','connected','unhealthy','expired','revoked')),
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  discovered_capabilities text[] NOT NULL DEFAULT '{}',
  last_successful_check_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  connected_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider),
  UNIQUE (workspace_id, id),
  CHECK (encrypted_access_token IS NULL OR length(encrypted_access_token) >= 32),
  CHECK (encrypted_refresh_token IS NULL OR length(encrypted_refresh_token) >= 32),
  CHECK (
    (status IN ('connected','unhealthy','expired') AND encrypted_access_token IS NOT NULL)
    OR (
      status IN ('disconnected','connecting','revoked')
      AND encrypted_access_token IS NULL
      AND encrypted_refresh_token IS NULL
    )
  )
);

CREATE TABLE growth_os.social_oauth_authorisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('linkedin','facebook','instagram','x','tiktok','snapchat')),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  encrypted_code_verifier text,
  redirect_uri text NOT NULL,
  requested_scopes text[] NOT NULL DEFAULT '{}',
  initiated_by uuid NOT NULL REFERENCES data_room.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (encrypted_code_verifier IS NULL OR length(encrypted_code_verifier) >= 32),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE TABLE growth_os.social_content_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  content_item_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('linkedin','facebook','instagram','x','tiktok','snapchat')),
  copy text,
  media_references jsonb NOT NULL DEFAULT '[]',
  destination_reference text,
  tracked_link_id uuid,
  copy_approved_at timestamptz,
  media_approved_at timestamptz,
  approved_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  approval_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, content_item_id, provider),
  UNIQUE (workspace_id, id),
  CHECK (approval_fingerprint IS NULL OR approval_fingerprint ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (workspace_id,content_item_id)
    REFERENCES growth_os.content_items(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,tracked_link_id)
    REFERENCES growth_os.tracked_links(workspace_id,id)
    ON DELETE SET NULL (tracked_link_id)
);

CREATE TABLE growth_os.social_publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  content_variant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','scheduled','publishing','published','failed','retry','cancelled')),
  scheduled_for timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  approval_fingerprint text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_post_id text,
  provider_post_url text,
  published_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  CHECK (approval_fingerprint IS NULL OR approval_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (status NOT IN ('approved','scheduled','publishing','published') OR approved_at IS NOT NULL),
  FOREIGN KEY (workspace_id,connection_id)
    REFERENCES growth_os.social_connections(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,content_variant_id)
    REFERENCES growth_os.social_content_variants(workspace_id,id) ON DELETE RESTRICT
);

CREATE TABLE growth_os.social_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  publish_job_id uuid,
  measured_at timestamptz NOT NULL,
  reach bigint,
  views bigint,
  clicks bigint,
  shares bigint,
  comments bigint,
  saves bigint,
  profile_visits bigint,
  followers bigint,
  direct_tracked_conversions bigint,
  likely_influence bigint,
  unknown_source_conversions bigint,
  raw_provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,connection_id)
    REFERENCES growth_os.social_connections(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,publish_job_id)
    REFERENCES growth_os.social_publish_jobs(workspace_id,id)
    ON DELETE SET NULL (publish_job_id)
);

CREATE TABLE growth_os.social_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  provider text,
  connection_id uuid,
  publish_job_id uuid,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('started','success','failure','blocked')),
  safe_details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,connection_id)
    REFERENCES growth_os.social_connections(workspace_id,id)
    ON DELETE SET NULL (connection_id),
  FOREIGN KEY (workspace_id,publish_job_id)
    REFERENCES growth_os.social_publish_jobs(workspace_id,id)
    ON DELETE SET NULL (publish_job_id)
);

CREATE INDEX IF NOT EXISTS growth_social_connections_workspace_status
  ON growth_os.social_connections(workspace_id,status);
CREATE INDEX IF NOT EXISTS growth_social_oauth_expiry
  ON growth_os.social_oauth_authorisations(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_social_oauth_pending_lookup
  ON growth_os.social_oauth_authorisations(workspace_id,provider,state_hash)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_social_jobs_schedule
  ON growth_os.social_publish_jobs(status,scheduled_for);
CREATE INDEX IF NOT EXISTS growth_social_jobs_workspace_schedule
  ON growth_os.social_publish_jobs(workspace_id,status,scheduled_for);
CREATE INDEX IF NOT EXISTS growth_social_metrics_workspace_date
  ON growth_os.social_metric_snapshots(workspace_id,measured_at DESC);
CREATE INDEX IF NOT EXISTS growth_social_audit_workspace_date
  ON growth_os.social_audit_events(workspace_id,occurred_at DESC);
CREATE UNIQUE INDEX growth_social_metrics_job_measurement_unique
  ON growth_os.social_metric_snapshots(connection_id,publish_job_id,measured_at)
  WHERE publish_job_id IS NOT NULL;
CREATE UNIQUE INDEX growth_social_metrics_connection_measurement_unique
  ON growth_os.social_metric_snapshots(connection_id,measured_at)
  WHERE publish_job_id IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_connections','social_content_variants','social_publish_jobs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON growth_os.%I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON growth_os.%I FOR EACH ROW EXECUTE FUNCTION growth_os.set_updated_at()',
      table_name, table_name
    );
  END LOOP;
END $$;

COMMIT;
