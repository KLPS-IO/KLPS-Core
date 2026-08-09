-- Canonicalise the duplicate prototype-materials expense category without changing accounting treatment.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance_os.accounting_export_configs
    WHERE category_nominal_codes ? 'Prototype materials/electronics'
      AND category_nominal_codes ? 'Prototype materials and electronics'
      AND category_nominal_codes->>'Prototype materials/electronics'
          IS DISTINCT FROM category_nominal_codes->>'Prototype materials and electronics'
  ) THEN
    RAISE EXCEPTION 'Conflicting prototype-material category mappings require manual review';
  END IF;
END $$;

UPDATE finance_os.expenses
SET category = 'Prototype materials and electronics'
WHERE category = 'Prototype materials/electronics';

INSERT INTO finance_os.accounting_export_config_versions (
  config_id, version, snapshot, change_reason, created_by
)
SELECT
  id,
  version,
  to_jsonb(config),
  'Canonicalised duplicate prototype-material expense category',
  updated_by
FROM finance_os.accounting_export_configs config
WHERE category_nominal_codes ? 'Prototype materials/electronics'
ON CONFLICT (config_id, version) DO NOTHING;

UPDATE finance_os.accounting_export_configs
SET category_nominal_codes = jsonb_set(
      category_nominal_codes - 'Prototype materials/electronics',
      ARRAY['Prototype materials and electronics'],
      COALESCE(
        category_nominal_codes->'Prototype materials and electronics',
        category_nominal_codes->'Prototype materials/electronics'
      ),
      true
    ),
    version = version + 1,
    change_reason = 'Canonicalised duplicate prototype-material expense category',
    updated_at = now()
WHERE category_nominal_codes ? 'Prototype materials/electronics';

COMMIT;
