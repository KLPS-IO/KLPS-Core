-- Preserve the provider account kind for verified social identities.
-- This migration is additive and seeds no social connections or credentials.
BEGIN;

DO $$
BEGIN
  IF to_regclass('growth_os.social_connections') IS NULL THEN
    RAISE EXCEPTION 'Required relation growth_os.social_connections does not exist; apply 20260730_growth_social_foundation.sql first';
  END IF;
END $$;

ALTER TABLE growth_os.social_connections
  ADD COLUMN IF NOT EXISTS provider_account_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'growth_os.social_connections'::regclass
      AND conname = 'social_connections_provider_account_type_check'
  ) THEN
    ALTER TABLE growth_os.social_connections
      ADD CONSTRAINT social_connections_provider_account_type_check
      CHECK (provider_account_type IS NULL OR provider_account_type IN ('member','organization'));
  END IF;
END $$;

COMMIT;
