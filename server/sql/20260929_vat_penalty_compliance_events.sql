-- Structured HMRC compliance events. Additive only; no notices, filings, actions, or evidence are seeded.
BEGIN;

CREATE TABLE finance_os.compliance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('vat_late_submission_penalty')),
  vat_period_id uuid REFERENCES finance_os.vat_periods(id) ON DELETE RESTRICT,
  canonical_period_reference text NOT NULL,
  source_period_reference text NOT NULL,
  notice_date date NOT NULL,
  event_date date NOT NULL,
  reason text NOT NULL,
  penalty_points integer NOT NULL DEFAULT 0 CHECK (penalty_points >= 0),
  total_penalty_points integer NOT NULL DEFAULT 0 CHECK (total_penalty_points >= 0),
  financial_penalty numeric(14,2) NOT NULL DEFAULT 0 CHECK (financial_penalty >= 0),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  review_deadline date,
  review_deadline_source_date date,
  review_deadline_rule text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved','cancelled')),
  dedupe_key text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  CHECK (event_type <> 'vat_late_submission_penalty' OR vat_period_id IS NOT NULL),
  CHECK (total_penalty_points >= penalty_points),
  CHECK ((review_deadline IS NULL) = (review_deadline_source_date IS NULL)),
  CHECK (review_deadline IS NULL OR review_deadline_rule IS NOT NULL)
);

CREATE INDEX compliance_events_period_notice
  ON finance_os.compliance_events(vat_period_id, notice_date DESC);
CREATE INDEX compliance_events_status_review
  ON finance_os.compliance_events(status, review_deadline);

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN (
 'assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','expense_adjustment','vat_filing',
 'rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation',
 'credit_facility','credit_term_version','credit_statement','bank_balance_observation','bank_account','bank_sync_run','bank_transaction',
 'compliance_event'));

COMMIT;
