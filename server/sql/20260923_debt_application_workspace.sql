-- Preparation domain only: deliberately no trigger writes to funding, credit or ledger tables.
BEGIN;
CREATE TABLE finance_os.debt_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES finance_os.company(id),
 applicant_id uuid NOT NULL REFERENCES data_room.users(id),
 application_key text NOT NULL,
 product text NOT NULL,
 partner text NOT NULL,
 status text NOT NULL DEFAULT 'Preparing' CHECK(status IN ('Preparing','Awaiting founder','Awaiting external evidence','Founder review','Paused')),
 requested_amount numeric(12,2) NOT NULL CHECK(requested_amount > 0),
 term_months integer NOT NULL CHECK(term_months BETWEEN 1 AND 600),
 indicative_rate numeric(8,5) NOT NULL CHECK(indicative_rate BETWEEN 0 AND 1),
 rate_source text NOT NULL,
 rate_as_of date NOT NULL,
 forecast_start date CHECK(forecast_start = date_trunc('month',forecast_start)::date),
 decision_status text NOT NULL DEFAULT 'Not submitted' CHECK(decision_status = 'Not submitted'),
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,applicant_id,application_key)
);
CREATE TABLE finance_os.debt_application_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES finance_os.debt_applications(id),
 code text NOT NULL,
 section text NOT NULL CHECK(section IN ('requirement','financial','budget','commercial','reconciliation','forecast','document')),
 title text NOT NULL,
 application_field text NOT NULL,
 status text NOT NULL DEFAULT 'Missing' CHECK(status IN ('Missing','Founder input','External evidence','Review required','Provisional','Resolved','Not applicable')),
 data jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data)='object'),
 source text NOT NULL DEFAULT '',
 source_date date,
 evidence_id uuid REFERENCES finance_os.evidence(id),
 evidence_version integer,
 evidence_file_version integer,
 locator text NOT NULL DEFAULT '',
 classification text NOT NULL DEFAULT 'Unknown' CHECK(classification IN ('Unknown','Extracted fact','Founder statement','Assumption','Calculation','Conflict')),
 rationale text NOT NULL DEFAULT '',
 next_action text NOT NULL DEFAULT '',
 owner text NOT NULL DEFAULT 'Founder',
 version integer NOT NULL DEFAULT 1,
 updated_by uuid REFERENCES data_room.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(application_id,code)
);
-- Minimum personal data, separate from company records, aggregate/export APIs and generic activity.
CREATE TABLE finance_os.debt_psb_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES finance_os.debt_applications(id),
 workbook_row integer NOT NULL CHECK(workbook_row BETWEEN 25 AND 32 OR workbook_row BETWEEN 36 AND 56),
 kind text NOT NULL CHECK(kind IN ('income','expense')),
 title text NOT NULL,
 monthly_amount numeric(12,2) CHECK(monthly_amount >= 0),
 status text NOT NULL DEFAULT 'Missing' CHECK(status IN ('Missing','Provisional','Reviewed','Not applicable')),
 source text NOT NULL DEFAULT '',
 source_date date,
 period_start date,
 period_end date,
 evidence_id uuid REFERENCES finance_os.evidence(id),
 evidence_version integer,
 evidence_file_version integer,
 locator text NOT NULL DEFAULT '',
 rationale text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(application_id,workbook_row),
 CHECK((kind='income' AND workbook_row BETWEEN 25 AND 32) OR (kind='expense' AND workbook_row BETWEEN 36 AND 56)),
 CHECK(status<>'Reviewed' OR (monthly_amount IS NOT NULL AND source<>'' AND source_date IS NOT NULL)),
 CHECK(status<>'Not applicable' OR (monthly_amount IS NULL AND rationale<>'')),
 CHECK(period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
CREATE TABLE finance_os.debt_application_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES finance_os.debt_applications(id),
 entity_id uuid NOT NULL,
 entity_kind text NOT NULL CHECK(entity_kind IN ('application','item','interaction','review')),
 entity_version integer NOT NULL,
 snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES data_room.users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(entity_id,entity_kind,entity_version)
);
CREATE TABLE finance_os.debt_psb_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES finance_os.debt_applications(id),
 entry_id uuid NOT NULL REFERENCES finance_os.debt_psb_entries(id),
 entry_version integer NOT NULL,
 snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES data_room.users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(entry_id,entry_version)
);
CREATE FUNCTION finance_os.debt_history_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Application provenance is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER debt_history_immutable BEFORE UPDATE OR DELETE ON finance_os.debt_application_history
 FOR EACH ROW EXECUTE FUNCTION finance_os.debt_history_immutable();
CREATE TRIGGER debt_psb_history_immutable BEFORE UPDATE OR DELETE ON finance_os.debt_psb_history
 FOR EACH ROW EXECUTE FUNCTION finance_os.debt_history_immutable();
-- Reuse the existing private evidence policy; this does not copy or change original file bytes.
CREATE TRIGGER debt_item_private AFTER INSERT OR UPDATE ON finance_os.debt_application_items
 FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_protect_evidence();
CREATE TRIGGER debt_psb_private AFTER INSERT OR UPDATE ON finance_os.debt_psb_entries
 FOR EACH ROW EXECUTE FUNCTION finance_os.readiness_protect_evidence();
CREATE INDEX ON finance_os.debt_application_items(application_id,section);
CREATE INDEX ON finance_os.debt_application_history(application_id,recorded_at);
CREATE INDEX ON finance_os.debt_psb_history(application_id,recorded_at);
COMMIT;
