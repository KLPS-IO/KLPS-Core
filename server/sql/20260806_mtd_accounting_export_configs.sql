-- Founder-controlled accounting-export mappings. Additive; no expense data is changed.
BEGIN;

CREATE OR REPLACE FUNCTION finance_os.valid_accounting_export_mapping(value jsonb)
RETURNS boolean AS $$
  SELECT jsonb_typeof(value)='object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(value) entry
      WHERE btrim(entry.key)='' OR jsonb_typeof(entry.value)<>'string'
        OR btrim(entry.value #>> '{}')=''
        OR entry.key<>btrim(entry.key) OR (entry.value #>> '{}')<>btrim(entry.value #>> '{}')
    );
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION finance_os.valid_accounting_payment_mapping(value jsonb)
RETURNS boolean AS $$
  SELECT finance_os.valid_accounting_export_mapping(value)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(value) key
      WHERE key NOT IN ('founder_director_funded','paypal','personal_credit_card','company_credit_card','business_bank','other')
    );
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE finance_os.accounting_export_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_type text NOT NULL CHECK(export_type='mtd_accounting'),
  profile text NOT NULL CHECK(profile='quickfile_purchase_csv_v1'),
  category_nominal_codes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(finance_os.valid_accounting_export_mapping(category_nominal_codes)),
  payment_account_nominal_codes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(finance_os.valid_accounting_payment_mapping(payment_account_nominal_codes)),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(export_type,profile),
  CHECK((confirmed_at IS NULL)=(confirmed_by IS NULL))
);

CREATE TABLE finance_os.accounting_export_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES finance_os.accounting_export_configs(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(config_id,version)
);

CREATE OR REPLACE FUNCTION finance_os.prevent_accounting_export_config_version_mutation()
RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'finance_os.accounting_export_config_versions is append-only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER accounting_export_config_versions_no_update
BEFORE UPDATE ON finance_os.accounting_export_config_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_accounting_export_config_version_mutation();
CREATE TRIGGER accounting_export_config_versions_no_delete
BEFORE DELETE ON finance_os.accounting_export_config_versions
FOR EACH ROW EXECUTE FUNCTION finance_os.prevent_accounting_export_config_version_mutation();

COMMIT;
