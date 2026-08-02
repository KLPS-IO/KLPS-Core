-- Run only to reverse an unapplied/unapproved Phase 1A rollout after confirming no Phase 1A data must be retained.
BEGIN;
DROP TABLE IF EXISTS finance_os.compliance_documents;
DROP TABLE IF EXISTS finance_os.expense_adjustments;
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_vat_evidence_type_check;
ALTER TABLE finance_os.evidence DROP COLUMN IF EXISTS vat_evidence_type,DROP COLUMN IF EXISTS supplier_name,DROP COLUMN IF EXISTS supplier_reference;
ALTER TABLE finance_os.expenses DROP CONSTRAINT IF EXISTS expenses_business_use_percentage_check,DROP CONSTRAINT IF EXISTS expenses_vat_treatment_check,DROP CONSTRAINT IF EXISTS expenses_vat_review_status_check,DROP CONSTRAINT IF EXISTS expenses_vat_gbp_amounts_check;
ALTER TABLE finance_os.expenses DROP COLUMN IF EXISTS invoice_date,DROP COLUMN IF EXISTS description,DROP COLUMN IF EXISTS payment_date,DROP COLUMN IF EXISTS supplier_country,DROP COLUMN IF EXISTS supplier_vat_number,DROP COLUMN IF EXISTS invoice_number,DROP COLUMN IF EXISTS order_reference,DROP COLUMN IF EXISTS payment_method,DROP COLUMN IF EXISTS payment_source,DROP COLUMN IF EXISTS founder_paid,DROP COLUMN IF EXISTS business_use_percentage,DROP COLUMN IF EXISTS exchange_rate,DROP COLUMN IF EXISTS gbp_net_amount,DROP COLUMN IF EXISTS gbp_vat_amount,DROP COLUMN IF EXISTS gbp_gross_amount,DROP COLUMN IF EXISTS recoverable_vat_amount,DROP COLUMN IF EXISTS vat_treatment,DROP COLUMN IF EXISTS vat_period_id,DROP COLUMN IF EXISTS vat_review_status,DROP COLUMN IF EXISTS vat_override_reason,DROP COLUMN IF EXISTS archived_at,DROP COLUMN IF EXISTS archived_by;
DROP TABLE IF EXISTS finance_os.vat_periods;
COMMIT;
