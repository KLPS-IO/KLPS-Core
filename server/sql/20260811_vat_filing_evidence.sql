-- Canonical evidence links for immutable VAT filings. No filing or evidence data is seeded.
BEGIN;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','expense_adjustment','vat_filing',
    'rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action',
    'rd_rfq','rd_quotation'
  ));

ALTER TABLE finance_os.evidence
  ADD COLUMN filing_evidence_purpose text;
ALTER TABLE finance_os.evidence
  ADD CONSTRAINT evidence_filing_evidence_purpose_check CHECK (
    filing_evidence_purpose IS NULL OR filing_evidence_purpose IN (
      'hmrc_submitted_vat_return','vat_return_submission_confirmation',
      'vat_return_filed_summary','vat_return_calculation_export',
      'accounting_export_snapshot','hmrc_obligation_confirmation',
      'other_vat_filing_support'
    )
  );

COMMIT;
