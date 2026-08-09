-- Removes only the supplier-document decision; expenses and evidence links remain intact.
BEGIN;

ALTER TABLE finance_os.expenses
  DROP CONSTRAINT IF EXISTS expenses_supplier_document_review_status_check,
  DROP COLUMN IF EXISTS supplier_document_review_status;

COMMIT;
