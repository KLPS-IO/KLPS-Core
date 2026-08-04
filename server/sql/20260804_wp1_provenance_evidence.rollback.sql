BEGIN;

DROP INDEX IF EXISTS finance_os.finance_risks_interaction;
DROP INDEX IF EXISTS finance_os.finance_decisions_interaction;
DROP INDEX IF EXISTS rd_lab.rd_actions_interaction;
DROP INDEX IF EXISTS rd_lab.rd_findings_interaction;
DROP INDEX IF EXISTS rd_lab.rd_interactions_timeline;
DROP INDEX IF EXISTS data_room.data_room_documents_evidence_unique;
DROP INDEX IF EXISTS finance_os.finance_evidence_checksum_unique;

ALTER TABLE data_room.documents DROP COLUMN IF EXISTS evidence_id;
ALTER TABLE finance_os.risks DROP COLUMN IF EXISTS interaction_id;
ALTER TABLE finance_os.decisions DROP COLUMN IF EXISTS interaction_id;
ALTER TABLE rd_lab.action_items DROP COLUMN IF EXISTS interaction_id;
ALTER TABLE rd_lab.technical_findings
  DROP CONSTRAINT IF EXISTS technical_findings_confidence_check,
  DROP CONSTRAINT IF EXISTS technical_findings_verification_status_check,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS founder_review_required;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','rd_work_package','rd_supplier',
    'rd_rfq','rd_quotation'
  ));

COMMIT;
