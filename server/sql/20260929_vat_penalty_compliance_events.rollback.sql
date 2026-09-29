-- Disposable/local rollback only. Refuse to discard canonical compliance history or evidence links.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_os.compliance_events)
     OR EXISTS (SELECT 1 FROM finance_os.evidence_links WHERE entity_type = 'compliance_event') THEN
    RAISE EXCEPTION 'Rollback refused: preserve compliance events and linked evidence';
  END IF;
END;
$$;

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN (
 'assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','expense_adjustment','vat_filing',
 'rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation',
 'credit_facility','credit_term_version','credit_statement','bank_balance_observation','bank_account','bank_sync_run','bank_transaction'));

DROP TABLE finance_os.compliance_events;

COMMIT;
