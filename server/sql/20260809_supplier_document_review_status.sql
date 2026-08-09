-- Separate founder supplier-document sufficiency decisions from VAT treatment.
BEGIN;

ALTER TABLE finance_os.expenses
  ADD COLUMN IF NOT EXISTS supplier_document_review_status text;

ALTER TABLE finance_os.expenses
  DROP CONSTRAINT IF EXISTS expenses_supplier_document_review_status_check;

ALTER TABLE finance_os.expenses
  ADD CONSTRAINT expenses_supplier_document_review_status_check CHECK (
    supplier_document_review_status IS NULL OR supplier_document_review_status IN (
      'pending_review',
      'vat_invoice_confirmed',
      'supporting_document_accepted_no_vat_claim',
      'alternative_vat_evidence_requires_specialist_review',
      'insufficient_evidence_exclude_from_export'
    )
  );

COMMIT;
