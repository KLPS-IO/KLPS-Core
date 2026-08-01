-- Minimal provider asset metadata discovered through an encrypted social connection.
-- This migration is additive and seeds no records.
BEGIN;

CREATE TABLE growth_os.social_connection_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  social_connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('facebook','instagram')),
  provider_asset_type text NOT NULL CHECK (provider_asset_type IN ('page','instagram_professional')),
  provider_asset_id text NOT NULL CHECK (length(provider_asset_id) BETWEEN 1 AND 255),
  provider_asset_name text NOT NULL CHECK (length(provider_asset_name) BETWEEN 1 AND 255),
  provider_asset_username text CHECK (
    provider_asset_username IS NULL OR length(provider_asset_username) BETWEEN 1 AND 255
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  UNIQUE (social_connection_id,provider,provider_asset_type,provider_asset_id),
  FOREIGN KEY (workspace_id,social_connection_id)
    REFERENCES growth_os.social_connections(workspace_id,id) ON DELETE CASCADE,
  CHECK (
    (provider='facebook' AND provider_asset_type='page' AND provider_asset_username IS NULL)
    OR (provider='instagram' AND provider_asset_type='instagram_professional')
  )
);

CREATE INDEX growth_social_connection_assets_workspace_connection
  ON growth_os.social_connection_assets(workspace_id,social_connection_id);

CREATE TRIGGER growth_social_connection_assets_updated_at
BEFORE UPDATE ON growth_os.social_connection_assets
FOR EACH ROW EXECUTE FUNCTION growth_os.set_updated_at();

COMMIT;
