BEGIN;

ALTER TABLE finance_os.evidence_links
  ADD COLUMN IF NOT EXISTS display_order integer,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

WITH ordered_links AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY entity_type, entity_id
      ORDER BY created_at, id
    ) * 100 AS display_order
  FROM finance_os.evidence_links
  WHERE display_order IS NULL
)
UPDATE finance_os.evidence_links AS evidence_link
SET display_order = ordered_links.display_order
FROM ordered_links
WHERE evidence_link.id = ordered_links.id;

ALTER TABLE finance_os.evidence_links
  ALTER COLUMN display_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_links_context_order
  ON finance_os.evidence_links (entity_type, entity_id, display_order, created_at);

ALTER TABLE finance_os.evidence_versions
  DROP CONSTRAINT IF EXISTS evidence_versions_evidence_id_fkey;

ALTER TABLE finance_os.evidence_versions
  ADD CONSTRAINT evidence_versions_evidence_id_fkey
  FOREIGN KEY (evidence_id)
  REFERENCES finance_os.evidence(id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION finance_os.prevent_evidence_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('klps.allow_canonical_evidence_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finance_os.evidence_versions is append-only';
END;
$$ LANGUAGE plpgsql;

COMMIT;
