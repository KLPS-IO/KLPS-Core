-- Disposable isolated test database only. Refuse to erase real credit data.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM finance_os.credit_facilities) OR EXISTS(SELECT 1 FROM finance_os.bank_balance_observations) OR EXISTS(SELECT 1 FROM finance_os.bank_transactions WHERE match_kind='transfer' OR source_evidence_id IS NOT NULL) THEN RAISE EXCEPTION 'Rollback refused: preserve credit evidence and history'; END IF;
END $$;
DROP TABLE finance_os.bank_balance_observations,finance_os.credit_statements,finance_os.credit_term_versions,finance_os.credit_facilities;
DROP FUNCTION finance_os.validate_credit_provenance(),finance_os.credit_history_immutable(),finance_os.validate_balance_observation();
ALTER TABLE finance_os.bank_transactions DROP CONSTRAINT bank_match_target;
ALTER TABLE finance_os.bank_transactions DROP COLUMN event_kind,DROP COLUMN source_evidence_id,DROP COLUMN source_row,DROP COLUMN conflict_payload,DROP COLUMN match_kind,DROP COLUMN counterpart_transaction_id,DROP COLUMN reviewed_by,DROP COLUMN reviewed_at;
ALTER TABLE finance_os.bank_transactions ADD CHECK((reconciliation_status='matched')=(expense_id IS NOT NULL));
ALTER TABLE finance_os.bank_accounts DROP COLUMN classification,DROP COLUMN classification_reviewed_at,DROP COLUMN classification_reviewed_by,DROP COLUMN stable_import_key;
ALTER TABLE finance_os.bank_sync_runs DROP COLUMN evidence_id,DROP COLUMN adapter_version,DROP COLUMN coverage_complete;
ALTER TABLE finance_os.bank_connections DROP CONSTRAINT manual_source_no_tokens;
ALTER TABLE finance_os.evidence_links DROP COLUMN field_provenance;
ALTER TABLE finance_os.evidence_links DROP CONSTRAINT evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN ('assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','expense_adjustment','vat_filing','rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation'));
COMMIT;
