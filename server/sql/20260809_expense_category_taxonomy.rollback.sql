-- Restore only expenses and mapping configurations changed by the taxonomy migration.
BEGIN;

UPDATE finance_os.expenses expense
SET category = 'Prototype materials/electronics'
FROM finance_os.expense_versions prior
WHERE expense.category = 'Prototype materials and electronics'
  AND prior.expense_id = expense.id
  AND prior.version = expense.version - 1
  AND prior.snapshot->>'category' = 'Prototype materials/electronics';

INSERT INTO finance_os.accounting_export_config_versions (
  config_id, version, snapshot, change_reason, created_by
)
SELECT
  config.id,
  config.version,
  to_jsonb(config),
  'Rolled back duplicate prototype-material expense category canonicalisation',
  config.updated_by
FROM finance_os.accounting_export_configs config
JOIN finance_os.accounting_export_config_versions prior
  ON prior.config_id = config.id
 AND prior.version = config.version - 1
 AND prior.change_reason = 'Canonicalised duplicate prototype-material expense category'
ON CONFLICT (config_id, version) DO NOTHING;

UPDATE finance_os.accounting_export_configs config
SET category_nominal_codes = prior.snapshot->'category_nominal_codes',
    version = config.version + 1,
    change_reason = 'Rolled back duplicate prototype-material expense category canonicalisation',
    updated_at = now()
FROM finance_os.accounting_export_config_versions prior
WHERE prior.config_id = config.id
  AND prior.version = config.version - 1
  AND prior.change_reason = 'Canonicalised duplicate prototype-material expense category';

COMMIT;
