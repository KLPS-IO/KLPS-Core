CREATE SCHEMA IF NOT EXISTS finance_os;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION finance_os.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS finance_os.scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  name text NOT NULL,
  category text NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  confidence_score numeric NOT NULL DEFAULT 0.5 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  confidence_level text NOT NULL DEFAULT 'medium' CHECK (confidence_level IN ('low', 'medium', 'high')),
  source text,
  owner text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'needs_evidence', 'deprecated')),
  notes text,
  linked_metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.assumption_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assumption_id uuid NOT NULL REFERENCES finance_os.assumptions(id),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  UNIQUE (assumption_id, version)
);

CREATE TABLE IF NOT EXISTS finance_os.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_type text NOT NULL CHECK (
    evidence_type IN (
      'supplier_quote',
      'research',
      'survey',
      'competitor_analysis',
      'contract',
      'invoice',
      'prototype_cost'
    )
  ),
  title text NOT NULL,
  summary text,
  source text,
  supplier_name text,
  document_id uuid,
  file_name text,
  file_size bigint,
  content_type text,
  storage_provider text NOT NULL DEFAULT 'placeholder',
  storage_key text,
  signed_url_available boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES finance_os.evidence(id),
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'assumption',
      'decision',
      'risk',
      'report',
      'scenario',
      'product',
      'hire',
      'funding',
      'document'
    )
  ),
  entity_id uuid NOT NULL,
  relationship text NOT NULL DEFAULT 'supports',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation',
  UNIQUE (evidence_id, entity_type, entity_id, relationship)
);

CREATE TABLE IF NOT EXISTS finance_os.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  name text NOT NULL,
  category text,
  price numeric,
  unit_cost numeric,
  launch_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.hires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  role_title text NOT NULL,
  department text,
  annual_salary numeric,
  start_month date,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'approved', 'hired', 'deferred')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  funding_type text NOT NULL,
  amount numeric NOT NULL,
  expected_date date,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'committed', 'received', 'withdrawn')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  title text NOT NULL,
  decision text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'superseded')),
  decided_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  title text NOT NULL,
  description text,
  category text,
  likelihood numeric CHECK (likelihood IS NULL OR (likelihood >= 0 AND likelihood <= 1)),
  impact numeric CHECK (impact IS NULL OR (impact >= 0 AND impact <= 1)),
  mitigation text,
  owner text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'monitoring', 'mitigated', 'closed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.model_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  scenario_key text NOT NULL,
  model_version integer NOT NULL,
  calculation_inputs jsonb NOT NULL,
  outputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  UNIQUE (scenario_key, model_version)
);

CREATE TABLE IF NOT EXISTS finance_os.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  model_snapshot_id uuid REFERENCES finance_os.model_snapshots(id),
  report_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('draft', 'generated', 'shared', 'archived')),
  content jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  document_type text NOT NULL,
  data_room_document_id uuid REFERENCES data_room.documents(id),
  file_name text,
  file_size bigint,
  content_type text,
  storage_provider text NOT NULL DEFAULT 'placeholder',
  storage_key text,
  signed_url_available boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.finance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  scenario_id uuid REFERENCES finance_os.scenarios(id),
  model_snapshot_id uuid REFERENCES finance_os.model_snapshots(id),
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id)
);

CREATE OR REPLACE FUNCTION finance_os.prevent_finance_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.finance_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS finance_events_no_update ON finance_os.finance_events;
CREATE TRIGGER finance_events_no_update
BEFORE UPDATE ON finance_os.finance_events
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_finance_event_mutation();

DROP TRIGGER IF EXISTS finance_events_no_delete ON finance_os.finance_events;
CREATE TRIGGER finance_events_no_delete
BEFORE DELETE ON finance_os.finance_events
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_finance_event_mutation();

CREATE OR REPLACE FUNCTION finance_os.prevent_assumption_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.assumption_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assumption_versions_no_update ON finance_os.assumption_versions;
CREATE TRIGGER assumption_versions_no_update
BEFORE UPDATE ON finance_os.assumption_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_assumption_version_mutation();

DROP TRIGGER IF EXISTS assumption_versions_no_delete ON finance_os.assumption_versions;
CREATE TRIGGER assumption_versions_no_delete
BEFORE DELETE ON finance_os.assumption_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_assumption_version_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scenarios',
    'assumptions',
    'evidence',
    'evidence_links',
    'products',
    'hires',
    'funding',
    'decisions',
    'risks',
    'reports',
    'documents'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON finance_os.%I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON finance_os.%I FOR EACH ROW EXECUTE FUNCTION finance_os.set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_finance_assumptions_scenario
  ON finance_os.assumptions (scenario_id, category, status);

CREATE INDEX IF NOT EXISTS idx_finance_evidence_type
  ON finance_os.evidence (evidence_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_evidence_links_entity
  ON finance_os.evidence_links (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_finance_events_created
  ON finance_os.finance_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_model_snapshots_latest
  ON finance_os.model_snapshots (scenario_key, model_version DESC);

INSERT INTO finance_os.scenarios (
  key,
  name,
  description,
  status,
  change_reason
)
VALUES (
  'base',
  'Base Case',
  'Default Finance OS planning scenario.',
  'active',
  'Seed default Finance OS scenario'
)
ON CONFLICT (key)
DO NOTHING;
