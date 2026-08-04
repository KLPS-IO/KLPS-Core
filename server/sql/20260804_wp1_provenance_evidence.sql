BEGIN;

-- Canonical files are content-addressed: one uploaded file, one Evidence entity.
CREATE UNIQUE INDEX IF NOT EXISTS finance_evidence_checksum_unique
  ON finance_os.evidence (checksum)
  WHERE checksum IS NOT NULL;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;

ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','rd_work_package','rd_supplier',
    'rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation'
  ));

ALTER TABLE rd_lab.technical_findings
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'Under Review',
  ADD COLUMN IF NOT EXISTS founder_review_required boolean NOT NULL DEFAULT true;

ALTER TABLE rd_lab.technical_findings
  DROP CONSTRAINT IF EXISTS technical_findings_confidence_check,
  DROP CONSTRAINT IF EXISTS technical_findings_verification_status_check;

ALTER TABLE rd_lab.technical_findings
  ADD CONSTRAINT technical_findings_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ADD CONSTRAINT technical_findings_verification_status_check
    CHECK (verification_status IN ('Unknown','Unverified','Under Review','Verified','Rejected','Expired'));

ALTER TABLE rd_lab.action_items
  ADD COLUMN IF NOT EXISTS interaction_id uuid
    REFERENCES rd_lab.interactions(id) ON DELETE SET NULL;

ALTER TABLE finance_os.decisions
  ADD COLUMN IF NOT EXISTS interaction_id uuid
    REFERENCES rd_lab.interactions(id) ON DELETE SET NULL;

ALTER TABLE finance_os.risks
  ADD COLUMN IF NOT EXISTS interaction_id uuid
    REFERENCES rd_lab.interactions(id) ON DELETE SET NULL;

ALTER TABLE data_room.documents
  ADD COLUMN IF NOT EXISTS evidence_id uuid
    REFERENCES finance_os.evidence(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS data_room_documents_evidence_unique
  ON data_room.documents (evidence_id)
  WHERE evidence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rd_interactions_timeline
  ON rd_lab.interactions (work_package_id, occurred_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS rd_findings_interaction
  ON rd_lab.technical_findings (interaction_id, created_at);
CREATE INDEX IF NOT EXISTS rd_actions_interaction
  ON rd_lab.action_items (interaction_id, created_at);
CREATE INDEX IF NOT EXISTS finance_decisions_interaction
  ON finance_os.decisions (interaction_id, created_at);
CREATE INDEX IF NOT EXISTS finance_risks_interaction
  ON finance_os.risks (interaction_id, created_at);

COMMIT;
