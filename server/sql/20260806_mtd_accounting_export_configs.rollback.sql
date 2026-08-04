-- Removes only the MTD Accounting Export mapping persistence increment.
BEGIN;
DROP TABLE IF EXISTS finance_os.accounting_export_config_versions;
DROP TABLE IF EXISTS finance_os.accounting_export_configs;
DROP FUNCTION IF EXISTS finance_os.prevent_accounting_export_config_version_mutation();
DROP FUNCTION IF EXISTS finance_os.valid_accounting_payment_mapping(jsonb);
DROP FUNCTION IF EXISTS finance_os.valid_accounting_export_mapping(jsonb);
COMMIT;
