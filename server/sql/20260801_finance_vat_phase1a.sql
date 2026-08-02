-- Financial OS VAT working-paper support. Additive; no historical expenses seeded.
BEGIN;

CREATE TABLE finance_os.vat_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date date NOT NULL,
  end_date date NOT NULL,
  filing_deadline date,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','submitted')),
  overdue boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'pending_review' CHECK(review_status IN ('pending_review','in_review','ready_for_review','review_complete')),
  locked_at timestamptz,
  locked_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(start_date,end_date),
  CHECK(start_date<=end_date),
  CHECK((locked_at IS NULL)=(locked_by IS NULL))
);

INSERT INTO finance_os.vat_periods(start_date,end_date,filing_deadline,overdue)
VALUES ('2025-05-08','2026-04-30','2026-06-07',true),
       ('2026-05-01','2026-07-31','2026-09-07',false)
ON CONFLICT(start_date,end_date) DO NOTHING;

ALTER TABLE finance_os.expenses
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS supplier_country text,
  ADD COLUMN IF NOT EXISTS supplier_vat_number text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS order_reference text,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS payment_source text,
  ADD COLUMN IF NOT EXISTS founder_paid boolean,
  ADD COLUMN IF NOT EXISTS business_use_percentage numeric(7,4),
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8),
  ADD COLUMN IF NOT EXISTS gbp_net_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS gbp_vat_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS gbp_gross_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS recoverable_vat_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS vat_treatment text,
  ADD COLUMN IF NOT EXISTS vat_period_id uuid REFERENCES finance_os.vat_periods(id),
  ADD COLUMN IF NOT EXISTS vat_review_status text,
  ADD COLUMN IF NOT EXISTS vat_override_reason text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES data_room.users(id);

ALTER TABLE finance_os.expenses ADD CONSTRAINT expenses_business_use_percentage_check
  CHECK(business_use_percentage IS NULL OR business_use_percentage BETWEEN 0 AND 1);
ALTER TABLE finance_os.expenses ADD CONSTRAINT expenses_vat_treatment_check CHECK(vat_treatment IS NULL OR vat_treatment IN
  ('standard_rated','reduced_rated','zero_rated','exempt','outside_scope','no_vat_shown','reverse_charge_review_required','import_vat_review_required','blocked_vat','partially_recoverable','personal_non_business','pending_review'));
ALTER TABLE finance_os.expenses ADD CONSTRAINT expenses_vat_review_status_check CHECK(vat_review_status IS NULL OR vat_review_status IN
  ('pending_review','in_review','ready_for_review','review_complete'));
ALTER TABLE finance_os.expenses ADD CONSTRAINT expenses_vat_gbp_amounts_check CHECK(
  (gbp_net_amount IS NULL OR gbp_net_amount>=0) AND (gbp_vat_amount IS NULL OR gbp_vat_amount>=0) AND
  (gbp_gross_amount IS NULL OR gbp_gross_amount>=0) AND (recoverable_vat_amount IS NULL OR recoverable_vat_amount>=0));

CREATE TABLE finance_os.expense_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expense_id uuid NOT NULL REFERENCES finance_os.expenses(id),
  adjustment_type text NOT NULL CHECK(adjustment_type IN ('supplier_refund','partial_refund','full_refund','credit_note','correction','chargeback','other_adjustment')),
  adjustment_date date NOT NULL, net_amount numeric(18,2), vat_amount numeric(18,2), gross_amount numeric(18,2),
  currency text NOT NULL DEFAULT 'GBP', gbp_net_amount numeric(18,2), gbp_vat_amount numeric(18,2), gbp_gross_amount numeric(18,2),
  reason text NOT NULL, supplier_reference text, evidence_id uuid REFERENCES finance_os.evidence(id),
  review_status text NOT NULL DEFAULT 'pending_review' CHECK(review_status IN ('pending_review','in_review','ready_for_review','review_complete')),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((net_amount IS NULL OR net_amount>=0) AND (vat_amount IS NULL OR vat_amount>=0) AND (gross_amount IS NULL OR gross_amount>=0)),
  CHECK((gbp_net_amount IS NULL OR gbp_net_amount>=0) AND (gbp_vat_amount IS NULL OR gbp_vat_amount>=0) AND (gbp_gross_amount IS NULL OR gbp_gross_amount>=0))
);

ALTER TABLE finance_os.evidence
  ADD COLUMN IF NOT EXISTS vat_evidence_type text,
  -- supplier_name predates Phase 1A; it is reused here and never owned by this migration.
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS supplier_reference text;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_vat_evidence_type_check CHECK(vat_evidence_type IS NULL OR vat_evidence_type IN
  ('full_vat_invoice','simplified_vat_invoice','retail_receipt','supplier_invoice_no_vat','order_confirmation','paypal_payment_receipt','card_bank_statement','credit_note','refund_confirmation','import_vat_evidence','proof_of_payment','other_supporting_document'));

CREATE TABLE finance_os.compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evidence_id uuid NOT NULL UNIQUE REFERENCES finance_os.evidence(id),
  compliance_type text NOT NULL CHECK(compliance_type IN ('hmrc_vat_registration_notice','hmrc_vat_assessment','hmrc_debt_management_letter','annual_accounting_scheme_correspondence','vat_liability_statement','penalty_notice','hmrc_general_correspondence','other_compliance_document')),
  company_id uuid NOT NULL REFERENCES finance_os.company(id), vat_period_id uuid REFERENCES finance_os.vat_periods(id),
  notes text, created_by uuid NOT NULL REFERENCES data_room.users(id), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vat_period_dates ON finance_os.vat_periods(start_date,end_date);
CREATE INDEX idx_expenses_vat_period ON finance_os.expenses(vat_period_id,transaction_date);
CREATE INDEX idx_expense_adjustments_expense ON finance_os.expense_adjustments(expense_id,adjustment_date);
COMMIT;
