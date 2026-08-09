-- Roll back Finance Compliance before the feature has been used.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_os.vat_filings)
     OR EXISTS (SELECT 1 FROM finance_os.finance_actions) THEN
    RAISE EXCEPTION 'Refusing rollback: finance actions or VAT filings exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS vat_filings_immutable_delete ON finance_os.vat_filings;
DROP TRIGGER IF EXISTS vat_filings_immutable_update ON finance_os.vat_filings;
DROP FUNCTION IF EXISTS finance_os.reject_vat_filing_mutation();
DROP TABLE IF EXISTS finance_os.vat_filings;

DROP TRIGGER IF EXISTS finance_actions_version_before_update ON finance_os.finance_actions;
DROP FUNCTION IF EXISTS finance_os.version_finance_action();
DROP TABLE IF EXISTS finance_os.finance_action_versions;
DROP TABLE IF EXISTS finance_os.finance_actions;

DELETE FROM finance_os.vat_periods
WHERE start_date = DATE '2026-08-01'
  AND end_date = DATE '2026-10-31'
  AND filing_deadline = DATE '2026-12-07';

UPDATE finance_os.vat_periods
SET filing_deadline = DATE '2026-06-07', updated_at = now()
WHERE start_date = DATE '2025-05-08'
  AND end_date = DATE '2026-04-30'
  AND filing_deadline = DATE '2026-06-30';

COMMIT;
