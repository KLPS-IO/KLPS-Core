-- Canonical uploaded-document contract.
-- `document` is required because the existing evidence types are all narrower
-- than a generic uploaded document. Storage naming remains backend-owned.

ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_evidence_type_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_evidence_type_check CHECK (
  evidence_type IN (
    'supplier_quote', 'research', 'survey', 'competitor_analysis',
    'contract', 'invoice', 'prototype_cost', 'document'
  )
);

ALTER TABLE finance_os.evidence ADD COLUMN IF NOT EXISTS document_date date;
ALTER TABLE finance_os.evidence DROP COLUMN IF EXISTS folder_path;

ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_document_category_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_document_category_check CHECK (
  document_category IS NULL OR document_category IN (
    'Read First', 'Corporate', 'Finance', 'Fundraising', 'Product', 'Technology',
    'Intellectual Property', 'Manufacturing', 'Market', 'Customers', 'Research',
    'Regulatory', 'Legal', 'Team', 'Press', 'Archive'
  )
);
