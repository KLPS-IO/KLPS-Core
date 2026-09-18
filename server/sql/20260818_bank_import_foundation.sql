-- Provider-neutral, read-only banking foundation and manual statement import staging.
-- Additive: no existing Finance OS records are changed.
BEGIN;

DO $$
BEGIN
  IF to_regnamespace('finance_os') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: schema finance_os';
  END IF;
  IF to_regclass('data_room.users') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: table data_room.users';
  END IF;
  IF to_regclass('finance_os.expenses') IS NULL THEN
    RAISE EXCEPTION 'Required dependency is missing: table finance_os.expenses';
  END IF;
END $$;

CREATE TABLE finance_os.bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','production')),
  provider_connection_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','expired','revoked','error','disconnected')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  consent_expires_at timestamptz,
  last_successful_sync_at timestamptz,
  last_error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  updated_by uuid NOT NULL REFERENCES data_room.users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  change_reason text NOT NULL,
  UNIQUE(provider,provider_environment,provider_connection_id),
  CHECK (encrypted_access_token IS NULL OR length(encrypted_access_token)>=32),
  CHECK (encrypted_refresh_token IS NULL OR length(encrypted_refresh_token)>=32),
  CHECK (provider<>'monzo_csv' OR (encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL AND token_expires_at IS NULL)),
  CHECK (provider <> 'monzo_csv' OR cardinality(granted_scopes)=0)
);

CREATE TABLE finance_os.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES finance_os.bank_connections(id) ON DELETE RESTRICT,
  provider_account_id text NOT NULL,
  display_name text NOT NULL,
  account_type text,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_identifier_masked text,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','closed')),
  current_balance numeric(20,8),
  available_balance numeric(20,8),
  balance_observed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  updated_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(connection_id,provider_account_id),
  UNIQUE(connection_id,id)
);

CREATE TABLE finance_os.bank_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES finance_os.bank_connections(id) ON DELETE RESTRICT,
  bank_account_id uuid,
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','production')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual_csv','manual','scheduled','webhook')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  source_filename text,
  source_checksum text CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  requested_from timestamptz,
  requested_to timestamptz,
  fetched_count integer NOT NULL DEFAULT 0 CHECK (fetched_count>=0),
  inserted_count integer NOT NULL DEFAULT 0 CHECK (inserted_count>=0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count>=0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count>=0),
  conflict_count integer NOT NULL DEFAULT 0 CHECK (conflict_count>=0),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  FOREIGN KEY(connection_id,bank_account_id) REFERENCES finance_os.bank_accounts(connection_id,id) ON DELETE RESTRICT,
  UNIQUE(connection_id,source_checksum)
);

CREATE TABLE finance_os.bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES finance_os.bank_accounts(id) ON DELETE RESTRICT,
  first_sync_run_id uuid NOT NULL REFERENCES finance_os.bank_sync_runs(id) ON DELETE RESTRICT,
  last_sync_run_id uuid NOT NULL REFERENCES finance_os.bank_sync_runs(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  provider_transaction_id text,
  status text NOT NULL CHECK (status IN ('pending','booked','rejected','reversed')),
  occurred_at timestamptz,
  booked_at timestamptz,
  booking_date date,
  value_date date,
  amount numeric(20,8) NOT NULL CHECK (amount<>0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction text NOT NULL CHECK (direction IN ('credit','debit')),
  merchant_name text,
  counterparty_name text,
  reference text,
  description text,
  provider_category text,
  provider_code text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_metadata)='object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  provider_updated_at timestamptz NOT NULL DEFAULT now(),
  reconciliation_status text NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_status IN ('unmatched','candidate','matched','ignored','conflict')),
  expense_id uuid REFERENCES finance_os.expenses(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bank_account_id,source_record_id),
  CHECK ((reconciliation_status='matched')=(expense_id IS NOT NULL))
);

CREATE INDEX bank_transactions_booking_date_idx ON finance_os.bank_transactions(bank_account_id,booking_date DESC);
CREATE INDEX bank_transactions_reconciliation_idx ON finance_os.bank_transactions(reconciliation_status,booking_date DESC);
CREATE INDEX bank_sync_runs_connection_idx ON finance_os.bank_sync_runs(connection_id,started_at DESC);

CREATE OR REPLACE FUNCTION finance_os.validate_bank_sync_environment()
RETURNS trigger AS $$
DECLARE connection_environment text;
BEGIN
  SELECT provider_environment INTO connection_environment
  FROM finance_os.bank_connections WHERE id=NEW.connection_id;
  IF connection_environment IS NULL OR connection_environment<>NEW.provider_environment THEN
    RAISE EXCEPTION 'Bank sync environment must exactly match its connection';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_sync_environment_guard
BEFORE INSERT OR UPDATE ON finance_os.bank_sync_runs
FOR EACH ROW EXECUTE FUNCTION finance_os.validate_bank_sync_environment();

COMMIT;
