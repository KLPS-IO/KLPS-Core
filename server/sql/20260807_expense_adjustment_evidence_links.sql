BEGIN;

ALTER TABLE finance_os.evidence_links
  DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;

ALTER TABLE finance_os.evidence_links
  ADD CONSTRAINT evidence_links_entity_type_check CHECK (entity_type IN (
    'assumption','product','decision','risk','company','funding','kpi','report',
    'scenario','hire','document','expense','expense_adjustment','rd_work_package',
    'rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation'
  ));

COMMIT;
