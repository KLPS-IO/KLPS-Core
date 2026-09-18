BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM finance_os.credit_facilities) THEN RAISE EXCEPTION 'Refuse populated credit rollback'; END IF;END $$;
DROP TRIGGER bank_transfer_pair ON finance_os.bank_transactions;
DROP TRIGGER credit_statement_source ON finance_os.credit_statements;
DROP TRIGGER credit_account_kind ON finance_os.credit_facilities;
DROP TRIGGER credit_facility_immutable ON finance_os.credit_facilities;
DROP FUNCTION finance_os.validate_bank_transfer_pair(),finance_os.validate_credit_statement(),finance_os.guard_credit_account();
COMMIT;
