-- Extend the existing private intake and application item workflow; no accounting effects.
BEGIN;
ALTER TABLE finance_os.debt_application_items DROP CONSTRAINT debt_application_items_section_check;
ALTER TABLE finance_os.debt_application_items ADD CONSTRAINT debt_application_items_section_check
 CHECK(section IN ('requirement','financial','budget','commercial','reconciliation','forecast','document','economics','engineering'));
ALTER TABLE finance_os.debt_psb_entries DROP CONSTRAINT debt_psb_entries_status_check;
ALTER TABLE finance_os.debt_psb_entries ADD CONSTRAINT debt_psb_entries_status_check
 CHECK(status IN ('Missing','Provisional','Working reconciled','Reviewed','Not applicable'));
ALTER TABLE finance_os.debt_psb_entries ADD COLUMN classification text NOT NULL DEFAULT 'Unclassified'
 CHECK(classification IN ('Unclassified','Founder-confirmed recurring amount','Statement-derived (founder confirmed)','Founder-approved normalised assumption','Not applicable'));
ALTER TABLE finance_os.debt_psb_entries ADD COLUMN components jsonb NOT NULL DEFAULT '[]'
 CHECK(jsonb_typeof(components)='array');
-- Append-only, applicant-private reconciliation checkpoint. Personal balances are disclosures
-- within PSB only; they never create canonical company liabilities or schedules.
CREATE TABLE finance_os.debt_psb_reconciliations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES finance_os.debt_applications(id),
 source text NOT NULL,
 source_date date NOT NULL,
 source_sha256 text CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 entry_versions jsonb NOT NULL CHECK(jsonb_typeof(entry_versions)='array'),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='array'),
 commitments jsonb NOT NULL CHECK(jsonb_typeof(commitments)='array'),
 exclusions jsonb NOT NULL CHECK(jsonb_typeof(exclusions)='array'),
 warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),
 actor_id uuid NOT NULL REFERENCES data_room.users(id),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON finance_os.debt_psb_reconciliations(application_id,recorded_at DESC);
CREATE TRIGGER debt_psb_reconciliation_immutable BEFORE UPDATE OR DELETE ON finance_os.debt_psb_reconciliations
 FOR EACH ROW EXECUTE FUNCTION finance_os.debt_history_immutable();
COMMIT;
