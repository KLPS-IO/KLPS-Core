-- Evidence-led current costs. This migration is intentionally not a forecast.
-- Evidence UUIDs remain null until real canonical Evidence records are linked.

BEGIN;

DO $$
BEGIN
  IF to_regnamespace('finance_os') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: schema finance_os';
  END IF;
  IF to_regclass('finance_os.evidence') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: table finance_os.evidence';
  END IF;
  IF to_regclass('finance_os.evidence_links') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: table finance_os.evidence_links';
  END IF;
  IF to_regprocedure('finance_os.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: function finance_os.set_updated_at()';
  END IF;
  IF to_regclass('data_room.users') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: table data_room.users';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS finance_os.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_key text NOT NULL UNIQUE,
  name text NOT NULL,
  supplier_name text,
  category text NOT NULL,
  cost_type text NOT NULL CHECK (cost_type IN (
    'Recurring operating cost', 'One-off programme cost', 'Recurring shared cost',
    'Planned or unconfirmed professional-service cost', 'Future operating cost',
    'Actual transaction'
  )),
  frequency text,
  transaction_date date,
  service_period_start date,
  service_period_end date,
  currency text NOT NULL DEFAULT 'GBP',
  net_amount numeric,
  credit_adjustment numeric,
  vat_amount numeric,
  vat_rate numeric,
  gross_amount numeric,
  supplier_cost_amount numeric,
  supplier_cost_basis text,
  recurring_run_rate_net numeric,
  recurring_run_rate_vat_rate numeric,
  klps_allocation_amount numeric,
  klps_allocation_percentage numeric,
  current_status text NOT NULL,
  paid_by text,
  payment_channel text,
  reimbursement_status text,
  company_cash_outflow boolean,
  business_expense_status text,
  evidence_status text NOT NULL CHECK (evidence_status IN ('Verified', 'Under Review', 'To Evidence', 'To Research')),
  evidence_reference text,
  evidence_id uuid REFERENCES finance_os.evidence(id),
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL,
  CHECK (net_amount IS NULL OR net_amount >= 0),
  CHECK (vat_amount IS NULL OR vat_amount >= 0),
  CHECK (gross_amount IS NULL OR gross_amount >= 0),
  CHECK (supplier_cost_amount IS NULL OR supplier_cost_amount >= 0),
  CHECK (recurring_run_rate_net IS NULL OR recurring_run_rate_net >= 0),
  CHECK (klps_allocation_amount IS NULL OR klps_allocation_amount >= 0),
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 1)),
  CHECK (recurring_run_rate_vat_rate IS NULL OR (recurring_run_rate_vat_rate >= 0 AND recurring_run_rate_vat_rate <= 1)),
  CHECK (klps_allocation_percentage IS NULL OR (klps_allocation_percentage >= 0 AND klps_allocation_percentage <= 1))
);

CREATE TABLE IF NOT EXISTS finance_os.expense_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES finance_os.expenses(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  UNIQUE (expense_id, version)
);

CREATE OR REPLACE FUNCTION finance_os.prevent_expense_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.expense_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expense_versions_no_update ON finance_os.expense_versions;
CREATE TRIGGER expense_versions_no_update BEFORE UPDATE ON finance_os.expense_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_expense_version_mutation();
DROP TRIGGER IF EXISTS expense_versions_no_delete ON finance_os.expense_versions;
CREATE TRIGGER expense_versions_no_delete BEFORE DELETE ON finance_os.expense_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_expense_version_mutation();
DROP TRIGGER IF EXISTS expenses_set_updated_at ON finance_os.expenses;
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON finance_os.expenses
FOR EACH ROW EXECUTE FUNCTION finance_os.set_updated_at();

CREATE OR REPLACE FUNCTION finance_os.capture_expense_version()
RETURNS trigger AS $$
BEGIN
  INSERT INTO finance_os.expense_versions (
    expense_id, version, snapshot, change_reason, created_by
  )
  VALUES (
    OLD.id, OLD.version, to_jsonb(OLD), NEW.change_reason, NEW.updated_by
  );
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expenses_capture_version ON finance_os.expenses;
CREATE TRIGGER expenses_capture_version BEFORE UPDATE ON finance_os.expenses
FOR EACH ROW
WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION finance_os.capture_expense_version();

CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON finance_os.expenses (transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_status ON finance_os.expenses (cost_type, current_status, evidence_status);

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK (
  entity_type IN (
    'assumption', 'product', 'decision', 'risk', 'company', 'funding', 'kpi',
    'report', 'scenario', 'hire', 'document', 'expense'
  )
);

INSERT INTO finance_os.expenses (
  import_key, name, supplier_name, category, cost_type, frequency,
  transaction_date, service_period_start, service_period_end, net_amount,
  credit_adjustment, vat_amount, vat_rate, gross_amount, supplier_cost_amount,
  supplier_cost_basis, recurring_run_rate_net, recurring_run_rate_vat_rate,
  klps_allocation_amount, klps_allocation_percentage, current_status, paid_by,
  payment_channel, reimbursement_status, company_cash_outflow,
  business_expense_status, evidence_status, evidence_reference, notes,
  metadata, change_reason
)
VALUES
(
  'actual-domain-ionos-2026', 'klps.co.uk domain registration and renewal',
  'IONOS Cloud Ltd', 'Software and infrastructure', 'Recurring operating cost',
  'Annual', '2026-01-06', '2026-01-05', '2027-01-04', 10.00, NULL, 2.00, 0.20,
  12.00, NULL, NULL, 10.00, 0.20, 12.00, 1.00, 'Paid', 'founder',
  'personal funds', 'not confirmed', false, 'subject to accountant review',
  'Verified', 'IONOS invoice number 203052672484',
  'Primary KLPS company domain. Evidence will be uploaded manually and linked later.',
  '{}'::jsonb, 'Initial actual-cost population from verified supplier invoice.'
),
(
  'actual-ffr-cohort9-2026', 'Female Founders Rise Cohort 9 Fundraising Accelerator',
  'Female Founders Rise Ltd', 'Fundraising and founder development',
  'One-off programme cost', 'One-off', '2026-05-28', NULL, NULL, 50.00, NULL,
  10.00, 0.20, 60.00, NULL, NULL, NULL, NULL, 60.00, 1.00, 'Paid', 'founder',
  'personal funds', 'not confirmed', false, 'subject to accountant review',
  'Verified', 'Receipt number 1143-5097',
  'Participation fee for the Cohort 9 Fundraising Accelerator. Evidence will be uploaded manually and linked later.',
  '{}'::jsonb, 'Initial actual-cost population from verified supplier receipt.'
),
(
  'current-chatgpt-plus-2026', 'ChatGPT Plus', 'OpenAI OpCo, LLC',
  'Software and AI', 'Recurring operating cost', 'Monthly', '2026-07-20',
  '2026-07-20', '2026-08-20', 15.56, -1.11, 3.11, 0.20, 18.67, NULL, NULL,
  16.67, 0.20, 18.67, 1.00, 'Payment status not confirmed', 'founder',
  'personal funds', 'not confirmed', false, 'subject to accountant review',
  'Verified', 'OpenAI invoice TZVOPHMG-0009',
  'Monthly ChatGPT Plus subscription used for KLPS research, financial modelling, technical development, grant and investor applications, document analysis and operating support. This is separate from OpenAI API usage. The invoice includes a GBP 1.11 net credit for unused ChatGPT Go subscription time; GBP 18.67 is the actual gross invoice total, not the recurring run-rate.',
  '{"invoice_number":"TZVOPHMG-0009","business_allocation":"100% KLPS","recurring_run_rate_treatment":"Use GBP 16.67 net plus applicable VAT; exclude the one-off credit adjustment."}'::jsonb,
  'Updated from placeholder pricing to verified OpenAI invoice values.'
),
(
  'shared-sovereign-studios-workspace-2026', 'Sovereign Studios shared workspace',
  'Sovereign Studios', 'Premises and workspace', 'Recurring shared cost', 'Weekly',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 100.00, 'per week', NULL,
  NULL, NULL, NULL, 'Active shared cost', 'founder', 'personal funds',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'The founder would continue renting the workspace without KLPS. Allocation amount and percentage remain unknown pending an approved usage-based method.',
  '{"business_allocation":"To be determined","evidence_required":"Rental agreement, invoice, payment record and documented allocation method"}'::jsonb,
  'Recorded shared workspace commitment without inventing the KLPS allocation.'
),
(
  'planned-blooming-books-accountancy-2026', 'Blooming Books accountancy and company filing support',
  'Blooming Books', 'Professional services', 'Planned or unconfirmed professional-service cost',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, 'Awaiting written confirmation', NULL, NULL, 'not confirmed', NULL,
  'subject to accountant review', 'To Evidence', NULL,
  'No numeric cost is recorded. A recalled approximate amount is not approved and requires written confirmation.',
  '{"business_allocation":"100% KLPS if commissioned","evidence_required":"Written proposal, engagement letter or invoice"}'::jsonb,
  'Supplier requirement logged while preserving the amount as unknown.'
),
(
  'planned-business-insurance-2026', 'Business insurance', NULL, 'Insurance',
  'Future operating cost', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, 'Not yet purchased', NULL, NULL, NULL, NULL,
  NULL, 'To Research', NULL,
  'KLPS currently has no business insurance. No expense or forecast premium is recorded.',
  '{"current_cost":"None","forecast_cost":"Unknown"}'::jsonb,
  'Current insurance position recorded without inventing premiums.'
),
(
  'paypal-ebay-2025-10-20-749', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-20', NULL, NULL, NULL, NULL, NULL, NULL, 7.49, NULL, NULL, NULL, NULL,
  7.49, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.',
  '{}'::jsonb, 'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-997', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 9.97, NULL, NULL, NULL, NULL,
  9.97, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-265', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 2.65, NULL, NULL, NULL, NULL,
  2.65, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-320', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 3.20, NULL, NULL, NULL, NULL,
  3.20, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-555', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 5.55, NULL, NULL, NULL, NULL,
  5.55, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-190', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 1.90, NULL, NULL, NULL, NULL,
  1.90, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-ebay-2025-10-05-1788', 'Prototype materials purchase', 'eBay Commerce UK Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 17.88, NULL, NULL, NULL, NULL,
  17.88, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-mann-2025-10-05-2270', 'Prototype materials purchase', 'Mann Enterprises Ltd',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 22.70, NULL, NULL, NULL, NULL,
  22.70, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
),
(
  'paypal-kitronik-2025-10-05-3174', 'Prototype materials purchase', 'Kitronik',
  'Prototype materials and electronics', 'Actual transaction', 'One-off',
  '2025-10-05', NULL, NULL, NULL, NULL, NULL, NULL, 31.74, NULL, NULL, NULL, NULL,
  31.74, 1.00, 'Paid', 'founder', 'KLPS PayPal funded by founder credit card',
  'not confirmed', false, 'subject to accountant review', 'Under Review', NULL,
  'Item-level receipt required before confirming component, VAT treatment and final subcategory.', '{}'::jsonb,
  'Initial completed supplier purchase from PayPal transaction evidence.'
)
ON CONFLICT (import_key) DO UPDATE SET
  name = EXCLUDED.name,
  supplier_name = EXCLUDED.supplier_name,
  category = EXCLUDED.category,
  cost_type = EXCLUDED.cost_type,
  frequency = EXCLUDED.frequency,
  transaction_date = EXCLUDED.transaction_date,
  service_period_start = EXCLUDED.service_period_start,
  service_period_end = EXCLUDED.service_period_end,
  net_amount = EXCLUDED.net_amount,
  credit_adjustment = EXCLUDED.credit_adjustment,
  vat_amount = EXCLUDED.vat_amount,
  vat_rate = EXCLUDED.vat_rate,
  gross_amount = EXCLUDED.gross_amount,
  supplier_cost_amount = EXCLUDED.supplier_cost_amount,
  supplier_cost_basis = EXCLUDED.supplier_cost_basis,
  recurring_run_rate_net = EXCLUDED.recurring_run_rate_net,
  recurring_run_rate_vat_rate = EXCLUDED.recurring_run_rate_vat_rate,
  klps_allocation_amount = EXCLUDED.klps_allocation_amount,
  klps_allocation_percentage = EXCLUDED.klps_allocation_percentage,
  current_status = EXCLUDED.current_status,
  paid_by = EXCLUDED.paid_by,
  payment_channel = EXCLUDED.payment_channel,
  reimbursement_status = EXCLUDED.reimbursement_status,
  company_cash_outflow = EXCLUDED.company_cash_outflow,
  business_expense_status = EXCLUDED.business_expense_status,
  evidence_status = EXCLUDED.evidence_status,
  evidence_reference = EXCLUDED.evidence_reference,
  notes = EXCLUDED.notes,
  metadata = EXCLUDED.metadata,
  change_reason = EXCLUDED.change_reason
WHERE (
  finance_os.expenses.name,
  finance_os.expenses.supplier_name,
  finance_os.expenses.category,
  finance_os.expenses.cost_type,
  finance_os.expenses.frequency,
  finance_os.expenses.transaction_date,
  finance_os.expenses.service_period_start,
  finance_os.expenses.service_period_end,
  finance_os.expenses.net_amount,
  finance_os.expenses.credit_adjustment,
  finance_os.expenses.vat_amount,
  finance_os.expenses.vat_rate,
  finance_os.expenses.gross_amount,
  finance_os.expenses.supplier_cost_amount,
  finance_os.expenses.supplier_cost_basis,
  finance_os.expenses.recurring_run_rate_net,
  finance_os.expenses.recurring_run_rate_vat_rate,
  finance_os.expenses.klps_allocation_amount,
  finance_os.expenses.klps_allocation_percentage,
  finance_os.expenses.current_status,
  finance_os.expenses.paid_by,
  finance_os.expenses.payment_channel,
  finance_os.expenses.reimbursement_status,
  finance_os.expenses.company_cash_outflow,
  finance_os.expenses.business_expense_status,
  finance_os.expenses.evidence_status,
  finance_os.expenses.evidence_reference,
  finance_os.expenses.notes,
  finance_os.expenses.metadata,
  finance_os.expenses.change_reason
) IS DISTINCT FROM (
  EXCLUDED.name,
  EXCLUDED.supplier_name,
  EXCLUDED.category,
  EXCLUDED.cost_type,
  EXCLUDED.frequency,
  EXCLUDED.transaction_date,
  EXCLUDED.service_period_start,
  EXCLUDED.service_period_end,
  EXCLUDED.net_amount,
  EXCLUDED.credit_adjustment,
  EXCLUDED.vat_amount,
  EXCLUDED.vat_rate,
  EXCLUDED.gross_amount,
  EXCLUDED.supplier_cost_amount,
  EXCLUDED.supplier_cost_basis,
  EXCLUDED.recurring_run_rate_net,
  EXCLUDED.recurring_run_rate_vat_rate,
  EXCLUDED.klps_allocation_amount,
  EXCLUDED.klps_allocation_percentage,
  EXCLUDED.current_status,
  EXCLUDED.paid_by,
  EXCLUDED.payment_channel,
  EXCLUDED.reimbursement_status,
  EXCLUDED.company_cash_outflow,
  EXCLUDED.business_expense_status,
  EXCLUDED.evidence_status,
  EXCLUDED.evidence_reference,
  EXCLUDED.notes,
  EXCLUDED.metadata,
  EXCLUDED.change_reason
);

COMMIT;
