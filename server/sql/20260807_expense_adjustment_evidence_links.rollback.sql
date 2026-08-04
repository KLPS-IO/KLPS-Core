BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_os.evidence_links
    WHERE entity_type = 'expense_adjustment'
  ) THEN
    RAISE EXCEPTION 'Rollback refused: expense_adjustment evidence links exist';
  END IF;
END $$;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;

ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','rd_work_package','rd_supplier',
    'rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation'
  ));

COMMIT;
