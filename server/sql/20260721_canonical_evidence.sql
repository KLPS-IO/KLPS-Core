-- Canonical Finance OS evidence metadata and relationships.
-- This migration is additive: existing UUIDs and rows are preserved.

CREATE SEQUENCE IF NOT EXISTS finance_os.evidence_code_seq;

ALTER TABLE finance_os.evidence
  ADD COLUMN IF NOT EXISTS evidence_code text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS document_category text,
  ADD COLUMN IF NOT EXISTS source_organisation text,
  ADD COLUMN IF NOT EXISTS owner text,
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS document_status text,
  ADD COLUMN IF NOT EXISTS review_frequency text,
  ADD COLUMN IF NOT EXISTS last_reviewed_date date,
  ADD COLUMN IF NOT EXISTS next_review_date date,
  ADD COLUMN IF NOT EXISTS expiry_date date,
  ADD COLUMN IF NOT EXISTS r2_object_key text,
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS checksum text,
  ADD COLUMN IF NOT EXISTS file_version integer,
  ADD COLUMN IF NOT EXISTS folder_path text;

-- Allocate codes only to real existing rows. The sequence makes concurrent
-- future inserts safe and evidence UUIDs remain the primary key.
UPDATE finance_os.evidence
SET evidence_code = 'EVD-' || lpad(nextval('finance_os.evidence_code_seq')::text, 4, '0')
WHERE evidence_code IS NULL;

SELECT setval(
  'finance_os.evidence_code_seq',
  GREATEST(
    COALESCE((SELECT max(substring(evidence_code FROM '^EVD-([0-9]+)$')::bigint) FROM finance_os.evidence), 0),
    1
  ),
  EXISTS (SELECT 1 FROM finance_os.evidence)
);

UPDATE finance_os.evidence SET description = summary WHERE description IS NULL;
UPDATE finance_os.evidence SET source_organisation = source WHERE source_organisation IS NULL;
UPDATE finance_os.evidence SET r2_object_key = storage_key WHERE r2_object_key IS NULL;
UPDATE finance_os.evidence SET original_filename = file_name WHERE original_filename IS NULL;
UPDATE finance_os.evidence SET mime_type = content_type WHERE mime_type IS NULL;
UPDATE finance_os.evidence SET verification_status = 'Unknown' WHERE verification_status IS NULL;
UPDATE finance_os.evidence SET document_status = 'Draft' WHERE document_status IS NULL;
UPDATE finance_os.evidence SET file_version = GREATEST(version, 1) WHERE file_version IS NULL;

ALTER TABLE finance_os.evidence
  ALTER COLUMN evidence_code SET NOT NULL,
  ALTER COLUMN evidence_code SET DEFAULT ('EVD-' || lpad(nextval('finance_os.evidence_code_seq')::text, 4, '0')),
  ALTER COLUMN verification_status SET NOT NULL,
  ALTER COLUMN verification_status SET DEFAULT 'Unknown',
  ALTER COLUMN document_status SET NOT NULL,
  ALTER COLUMN document_status SET DEFAULT 'Draft',
  ALTER COLUMN file_version SET NOT NULL,
  ALTER COLUMN file_version SET DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_evidence_code
  ON finance_os.evidence (evidence_code);

ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_document_category_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_document_category_check CHECK (
  document_category IS NULL OR document_category IN (
    'Corporate', 'Finance', 'Fundraising', 'Product', 'Technology',
    'Intellectual Property', 'Manufacturing', 'Market', 'Customers',
    'Research', 'Regulatory', 'Legal', 'Team', 'Press', 'Archive'
  )
);
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_verification_status_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_verification_status_check CHECK (
  verification_status IN ('Unknown', 'Unverified', 'Under Review', 'Verified', 'Rejected', 'Expired')
);
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_document_status_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_document_status_check CHECK (
  document_status IN ('Draft', 'Active', 'Superseded', 'Archived', 'Expired')
);
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_confidence_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_confidence_check CHECK (
  confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
);
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_file_size_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_file_size_check CHECK (file_size IS NULL OR file_size >= 0);
ALTER TABLE finance_os.evidence DROP CONSTRAINT IF EXISTS evidence_file_version_check;
ALTER TABLE finance_os.evidence ADD CONSTRAINT evidence_file_version_check CHECK (file_version >= 1);

CREATE TABLE IF NOT EXISTS finance_os.evidence_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES finance_os.evidence(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id),
  UNIQUE (evidence_id, version)
);

CREATE OR REPLACE FUNCTION finance_os.prevent_evidence_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'finance_os.evidence_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_versions_no_update ON finance_os.evidence_versions;
CREATE TRIGGER evidence_versions_no_update BEFORE UPDATE ON finance_os.evidence_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_evidence_version_mutation();
DROP TRIGGER IF EXISTS evidence_versions_no_delete ON finance_os.evidence_versions;
CREATE TRIGGER evidence_versions_no_delete BEFORE DELETE ON finance_os.evidence_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_evidence_version_mutation();

-- Retain the existing table and relationships while tightening supported names.
ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK (
  entity_type IN (
    'assumption', 'product', 'decision', 'risk', 'company', 'funding', 'kpi',
    'report', 'scenario', 'hire', 'document'
  )
);
ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_evidence_id_fkey;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_evidence_id_fkey
  FOREIGN KEY (evidence_id) REFERENCES finance_os.evidence(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_finance_evidence_filters ON finance_os.evidence
  (document_category, verification_status, document_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_evidence_owner ON finance_os.evidence (owner);
CREATE INDEX IF NOT EXISTS idx_finance_evidence_source_org ON finance_os.evidence (source_organisation);
CREATE INDEX IF NOT EXISTS idx_finance_evidence_versions ON finance_os.evidence_versions (evidence_id, version DESC);
