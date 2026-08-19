-- Disable application routes before applying. Existing expenses are untouched.
BEGIN;
DROP TRIGGER IF EXISTS bank_sync_environment_guard ON finance_os.bank_sync_runs;
DROP FUNCTION IF EXISTS finance_os.validate_bank_sync_environment();
DROP TABLE IF EXISTS finance_os.bank_transactions;
DROP TABLE IF EXISTS finance_os.bank_sync_runs;
DROP TABLE IF EXISTS finance_os.bank_accounts;
DROP TABLE IF EXISTS finance_os.bank_connections;
COMMIT;
