BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_os.evidence_links WHERE entity_type = 'vat_filing'
  ) THEN
    RAISE EXCEPTION 'Cannot roll back VAT filing evidence while filing links exist';
  END IF;
END $$;

ALTER TABLE finance_os.evidence
  DROP CONSTRAINT IF EXISTS evidence_filing_evidence_purpose_check;
ALTER TABLE finance_os.evidence
  DROP COLUMN IF EXISTS filing_evidence_purpose;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','expense_adjustment','rd_work_package',
    'rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation'
  ));

COMMIT;
