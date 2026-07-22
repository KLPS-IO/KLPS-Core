-- Canonical KLPS company identity, compliance and readiness data.
-- CRL uses the same conservative 1-9 range as TRL because Finance OS has no
-- existing project-specific CRL scale.

CREATE TABLE IF NOT EXISTS finance_os.company (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  trading_name text NOT NULL,
  company_number text NOT NULL UNIQUE,
  company_type text NOT NULL,
  company_status text NOT NULL CHECK (company_status IN ('Active', 'Dormant', 'Closed', 'Dissolved')),
  incorporation_date date NOT NULL,
  registered_office_line_1 text,
  registered_office_line_2 text,
  registered_office_line_3 text,
  registered_office_city text,
  registered_office_county text,
  registered_office_postcode text,
  registered_office_country text,
  base_currency text NOT NULL DEFAULT 'GBP',
  financial_year_end_month integer CHECK (financial_year_end_month IS NULL OR financial_year_end_month BETWEEN 1 AND 12),
  financial_year_end_day integer CHECK (financial_year_end_day IS NULL OR financial_year_end_day BETWEEN 1 AND 31),
  first_accounts_period_end date,
  first_accounts_filing_deadline date,
  accounting_method text CHECK (accounting_method IS NULL OR accounting_method IN ('Unknown', 'Cash', 'Accrual')),
  corporation_tax_status text CHECK (corporation_tax_status IS NULL OR corporation_tax_status IN ('Unknown', 'Registered', 'Active', 'Dormant', 'Closed')),
  sic_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sic_codes) = 'array'),
  vat_status text CHECK (vat_status IS NULL OR vat_status IN ('Not Started', 'Applied', 'Approved', 'Rejected', 'Cancelled')),
  vat_registration_number text,
  vat_effective_date date,
  vat_scheme text,
  vat_accounting_period_start date,
  vat_accounting_period_end date,
  ico_status text CHECK (ico_status IS NULL OR ico_status IN ('Not Started', 'Preparing', 'Applied', 'Registered', 'Exempt', 'Cancelled')),
  ico_registration_number text,
  seis_status text CHECK (seis_status IS NULL OR seis_status IN ('Not Started', 'Preparing', 'Submitted', 'Approved', 'Rejected')),
  seis_advance_assurance_status text CHECK (seis_advance_assurance_status IS NULL OR seis_advance_assurance_status IN ('Not Submitted', 'Preparing', 'Submitted', 'Under Review', 'Approved', 'Rejected')),
  seis_target_submission_period text,
  seis_reference_number text,
  seis_decision_date date,
  business_bank_name text,
  business_bank_status text CHECK (business_bank_status IS NULL OR business_bank_status IN ('Not Opened', 'Application Pending', 'Under Review', 'Open', 'Rejected', 'Closed')),
  business_bank_opened_date date,
  trl integer CHECK (trl IS NULL OR trl BETWEEN 1 AND 9),
  crl integer CHECK (crl IS NULL OR crl BETWEEN 1 AND 9),
  founder_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  updated_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  change_reason text NOT NULL DEFAULT 'Initial creation'
);

CREATE TABLE IF NOT EXISTS finance_os.company_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES finance_os.company(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  UNIQUE (company_id, version)
);

CREATE OR REPLACE FUNCTION finance_os.prevent_company_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.company_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_versions_no_update ON finance_os.company_versions;
CREATE TRIGGER company_versions_no_update BEFORE UPDATE ON finance_os.company_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_company_version_mutation();
DROP TRIGGER IF EXISTS company_versions_no_delete ON finance_os.company_versions;
CREATE TRIGGER company_versions_no_delete BEFORE DELETE ON finance_os.company_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_company_version_mutation();

DROP TRIGGER IF EXISTS company_set_updated_at ON finance_os.company;
CREATE TRIGGER company_set_updated_at BEFORE UPDATE ON finance_os.company
FOR EACH ROW EXECUTE FUNCTION finance_os.set_updated_at();

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK (
  entity_type IN (
    'assumption', 'product', 'decision', 'risk', 'company', 'funding', 'kpi',
    'report', 'scenario', 'hire', 'document'
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_company_versions
  ON finance_os.company_versions (company_id, version DESC);

INSERT INTO finance_os.company (
  legal_name, trading_name, company_number, company_type, company_status,
  incorporation_date, registered_office_line_1, registered_office_line_2,
  registered_office_line_3, registered_office_city, registered_office_county,
  registered_office_postcode, registered_office_country, base_currency,
  financial_year_end_month, financial_year_end_day, first_accounts_period_end,
  first_accounts_filing_deadline, accounting_method, corporation_tax_status,
  sic_codes, vat_status, vat_registration_number, vat_effective_date, vat_scheme,
  vat_accounting_period_start, vat_accounting_period_end, ico_status,
  ico_registration_number, seis_status, seis_advance_assurance_status,
  seis_target_submission_period, seis_reference_number, seis_decision_date,
  business_bank_name, business_bank_status, business_bank_opened_date, trl, crl,
  founder_name, change_reason
)
VALUES (
  'KIDS, LADIES & PARENTS, SPECIALISTS LTD', 'KLPS', '16436591',
  'Private limited company', 'Active', '2025-05-08', 'Unit 3a Imex Industrial Estate',
  'Western House', 'Western Road, Hockley', 'Birmingham', 'West Midlands', 'B18 7QD',
  'United Kingdom', 'GBP', 5, 31, '2026-05-31', '2027-02-08', 'Unknown',
  'Unknown', '["13990", "62012", "72190", "74100"]'::jsonb, 'Approved',
  '522998359', '2025-05-08', 'Annual Accounting Scheme', '2025-05-08',
  '2026-04-30', 'Not Started', NULL, 'Preparing', 'Not Submitted', '2026-07',
  NULL, NULL, 'Starling Business', 'Application Pending', NULL, 3, NULL,
  'Emma Mendez', 'Seed verified canonical KLPS company facts'
)
ON CONFLICT (company_number) DO NOTHING;
