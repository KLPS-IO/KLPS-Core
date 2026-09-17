-- Internal preparation only. No ownership, accounting or external transaction is created.
BEGIN;
ALTER TABLE finance_os.evidence ADD COLUMN IF NOT EXISTS founder_only boolean NOT NULL DEFAULT false;
-- Existing published material keeps its policy. Newly registered working evidence is private.
ALTER TABLE finance_os.evidence ALTER COLUMN founder_only SET DEFAULT true;

CREATE TABLE finance_os.fundraising_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES finance_os.company(id),
  provider text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'Preparing' CHECK (status IN ('Preparing','In progress','Awaiting founder','Awaiting provider','Complete','Paused')),
  budget_ex_vat numeric(12,2) CHECK (budget_ex_vat >= 0),
  currency text NOT NULL DEFAULT 'GBP',
  price_basis text NOT NULL,
  price_evidence_id uuid REFERENCES finance_os.evidence(id),
  service_purchased text,
  start_date date,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, provider)
);

CREATE TABLE finance_os.fundraising_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES finance_os.fundraising_engagements(id),
  code text NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  canonical_location text NOT NULL,
  required_document text,
  owner text NOT NULL,
  dependency text NOT NULL DEFAULT '',
  classification text NOT NULL DEFAULT 'MISSING' CHECK (classification IN (
    'AVAILABLE + VERIFIED','AVAILABLE + REVIEW REQUIRED','MISSING','FOUNDER INPUT REQUIRED',
    'EXTERNAL ACTION REQUIRED','CONFLICT — REVIEW REQUIRED','NOT APPLICABLE')),
  next_action text NOT NULL,
  notes text NOT NULL DEFAULT '',
  evidence_id uuid REFERENCES finance_os.evidence(id),
  reviewed_evidence_version integer,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES data_room.users(id),
  UNIQUE(engagement_id, code)
);

CREATE TABLE finance_os.fundraising_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES finance_os.fundraising_engagements(id),
  kind text NOT NULL CHECK (kind IN ('founder_decision','provider_decision','correspondence','milestone','document_received','document_generated','supplied','approval','cost_reference','payment_reference','audit')),
  description text NOT NULL,
  evidence_id uuid REFERENCES finance_os.evidence(id),
  occurred_on date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES data_room.users(id),
  source text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Actual and historical ownership are immutable evidence-backed records, never scenario rows.
-- There is deliberately no issuance/approval endpoint in this phase.
CREATE TABLE finance_os.ownership_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES finance_os.company(id),
  scope text NOT NULL CHECK(scope IN ('ACTUAL','HISTORICAL')),
  effective_date date NOT NULL,
  verification_status text NOT NULL CHECK(verification_status IN ('VERIFIED','PROVISIONAL','PENDING EVIDENCE','CONFLICT — REVIEW REQUIRED')),
  holdings jsonb NOT NULL CHECK(jsonb_typeof(holdings) = 'array' AND jsonb_array_length(holdings) > 0),
  evidence_id uuid NOT NULL REFERENCES finance_os.evidence(id),
  evidence_version integer NOT NULL,
  review_notes text NOT NULL,
  approved_by uuid REFERENCES data_room.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK(verification_status <> 'VERIFIED' OR approved_by IS NOT NULL)
);

CREATE TABLE finance_os.fundraising_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES finance_os.fundraising_engagements(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'SCENARIO' CHECK(status = 'SCENARIO'),
  baseline_id uuid REFERENCES finance_os.ownership_snapshots(id),
  proposed_investment numeric(16,2) CHECK(proposed_investment > 0),
  pre_money_valuation numeric(16,2) CHECK(pre_money_valuation > 0),
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION finance_os.readiness_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Readiness history is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fundraising_activity_immutable BEFORE UPDATE OR DELETE ON finance_os.fundraising_activity
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_immutable();
CREATE TRIGGER ownership_snapshots_immutable BEFORE UPDATE OR DELETE ON finance_os.ownership_snapshots
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_immutable();

CREATE FUNCTION finance_os.readiness_validate_snapshot() RETURNS trigger AS $$
DECLARE holding jsonb;
BEGIN
  IF NEW.verification_status = 'VERIFIED' AND NOT EXISTS (
    SELECT 1 FROM finance_os.evidence WHERE id=NEW.evidence_id AND version=NEW.evidence_version
    AND verification_status='Verified' AND document_status='Active'
  ) THEN RAISE EXCEPTION 'Verified snapshot requires matching active verified evidence'; END IF;
  FOR holding IN SELECT * FROM jsonb_array_elements(NEW.holdings) LOOP
    IF NOT (holding ?& ARRAY['shareholder','shareholder_type','share_class','shares','nominal_value','amount_paid','amount_unpaid','acquisition_date','voting_rights'])
      OR jsonb_typeof(holding->'shares') <> 'number' OR (holding->>'shares')::numeric <= 0
      OR (holding->>'shares')::numeric <> trunc((holding->>'shares')::numeric)
      OR (holding->>'shares')::numeric > 9007199254740991
      OR jsonb_typeof(holding->'nominal_value') <> 'number' OR (holding->>'nominal_value')::numeric < 0
      OR jsonb_typeof(holding->'amount_paid') <> 'number' OR (holding->>'amount_paid')::numeric < 0
      OR jsonb_typeof(holding->'amount_unpaid') <> 'number' OR (holding->>'amount_unpaid')::numeric < 0
    THEN RAISE EXCEPTION 'Invalid ownership holding'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ownership_snapshot_validation BEFORE INSERT ON finance_os.ownership_snapshots
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_validate_snapshot();

-- Evidence linked to this private workstream remains private even if also presented elsewhere.
CREATE FUNCTION finance_os.readiness_protect_evidence() RETURNS trigger AS $$
BEGIN
  IF NEW.evidence_id IS NOT NULL THEN
    UPDATE finance_os.evidence SET founder_only = true WHERE id = NEW.evidence_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER readiness_requirement_private AFTER INSERT OR UPDATE ON finance_os.fundraising_requirements
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_protect_evidence();
CREATE TRIGGER readiness_activity_private AFTER INSERT ON finance_os.fundraising_activity
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_protect_evidence();
CREATE TRIGGER readiness_snapshot_private AFTER INSERT ON finance_os.ownership_snapshots
FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_protect_evidence();

CREATE INDEX ON finance_os.fundraising_requirements(engagement_id, code);
CREATE INDEX ON finance_os.fundraising_activity(engagement_id, recorded_at);
CREATE INDEX ON finance_os.ownership_snapshots(company_id, effective_date);
COMMIT;
