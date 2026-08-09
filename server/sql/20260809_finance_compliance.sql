-- Finance Compliance: persisted actions, immutable VAT filings and canonical periods.
-- Intentionally contains no historical filing data.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE finance_os.vat_periods
SET filing_deadline = DATE '2026-06-30', updated_at = now()
WHERE start_date = DATE '2025-05-08'
  AND end_date = DATE '2026-04-30'
  AND filing_deadline = DATE '2026-06-07';

INSERT INTO finance_os.vat_periods
  (start_date, end_date, filing_deadline, status)
VALUES
  (DATE '2026-08-01', DATE '2026-10-31', DATE '2026-12-07', 'open')
ON CONFLICT (start_date, end_date) DO UPDATE
SET filing_deadline = EXCLUDED.filing_deadline,
    updated_at = CASE
      WHEN finance_os.vat_periods.filing_deadline IS DISTINCT FROM EXCLUDED.filing_deadline
      THEN now() ELSE finance_os.vat_periods.updated_at END;

CREATE TABLE finance_os.finance_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','waiting','completed','dismissed')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','critical')),
  due_date date,
  recommended_start_date date,
  is_system_generated boolean NOT NULL DEFAULT true,
  is_machine_verifiable boolean NOT NULL DEFAULT true,
  dedupe_key text NOT NULL UNIQUE,
  deep_link text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  change_reason text,
  completed_at timestamptz,
  completed_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL
);

CREATE INDEX finance_actions_status_due
  ON finance_os.finance_actions(status, due_date, recommended_start_date);
CREATE INDEX finance_actions_entity
  ON finance_os.finance_actions(entity_type, entity_id);

CREATE TABLE finance_os.finance_action_versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL,
  action_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES data_room.users(id) ON DELETE SET NULL,
  change_reason text,
  UNIQUE (action_id, action_version)
);

CREATE OR REPLACE FUNCTION finance_os.version_finance_action() RETURNS trigger AS $$
BEGIN
  INSERT INTO finance_os.finance_action_versions
    (action_id, action_version, snapshot, changed_by, change_reason)
  VALUES (OLD.id, OLD.version, to_jsonb(OLD), NEW.updated_by, NEW.change_reason);
  NEW.version = OLD.version + 1;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER finance_actions_version_before_update
BEFORE UPDATE ON finance_os.finance_actions
FOR EACH ROW EXECUTE FUNCTION finance_os.version_finance_action();

CREATE TABLE finance_os.vat_filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vat_period_id uuid NOT NULL REFERENCES finance_os.vat_periods(id) ON DELETE RESTRICT,
  obligation_reference text NOT NULL,
  submitted_at timestamptz NOT NULL,
  submission_method text NOT NULL,
  result text NOT NULL CHECK (result IN ('delivered','accepted','delivered_accepted')),
  hmrc_receipt_id text NOT NULL,
  box_1 numeric(14,2) NOT NULL,
  box_2 numeric(14,2) NOT NULL,
  box_3 numeric(14,2) NOT NULL,
  box_4 numeric(14,2) NOT NULL,
  box_5 numeric(14,2) NOT NULL,
  box_6 numeric(14,2) NOT NULL,
  box_7 numeric(14,2) NOT NULL,
  box_8 numeric(14,2) NOT NULL,
  box_9 numeric(14,2) NOT NULL,
  source_ledger_fingerprint text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id) ON DELETE RESTRICT,
  UNIQUE (vat_period_id),
  UNIQUE (obligation_reference)
);

CREATE INDEX vat_filings_submitted_at
  ON finance_os.vat_filings(submitted_at DESC);

CREATE OR REPLACE FUNCTION finance_os.reject_vat_filing_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.vat_filings is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vat_filings_immutable_update
BEFORE UPDATE ON finance_os.vat_filings
FOR EACH ROW EXECUTE FUNCTION finance_os.reject_vat_filing_mutation();
CREATE TRIGGER vat_filings_immutable_delete
BEFORE DELETE ON finance_os.vat_filings
FOR EACH ROW EXECUTE FUNCTION finance_os.reject_vat_filing_mutation();

COMMIT;
