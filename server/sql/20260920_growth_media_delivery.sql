BEGIN;
ALTER TABLE growth_os.social_publish_jobs ADD COLUMN provider_container_id text;
ALTER TABLE growth_os.social_publish_jobs ADD COLUMN provider_container_status text;
CREATE UNIQUE INDEX IF NOT EXISTS growth_media_workspace_id ON growth_os.media_assets(workspace_id,id);
CREATE TABLE growth_os.publishing_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 media_asset_id uuid NOT NULL, object_key text NOT NULL UNIQUE,
 sha256 text NOT NULL, mime_type text NOT NULL CHECK(mime_type='image/jpeg'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608),
 state text NOT NULL DEFAULT 'private' CHECK(state IN ('private','approved','revoked')),
 approved_by uuid REFERENCES data_room.users(id), approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,media_asset_id) REFERENCES growth_os.media_assets(workspace_id,id) ON DELETE RESTRICT,
 CHECK(state <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE growth_os.media_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 publishing_asset_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('facebook','instagram','tiktok','x','linkedin','snapchat')),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_retrieved_at timestamptz,
 publish_job_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,publishing_asset_id) REFERENCES growth_os.publishing_assets(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,publish_job_id) REFERENCES growth_os.social_publish_jobs(workspace_id,id) ON DELETE RESTRICT
);
-- Withdrawing source approval permanently revokes existing publishing versions.
CREATE FUNCTION growth_os.revoke_media_publications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.approved_for_use AND NOT NEW.approved_for_use THEN
  UPDATE growth_os.publishing_assets SET state='revoked' WHERE media_asset_id=NEW.id AND workspace_id=NEW.workspace_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_media_revoke_publications AFTER UPDATE OF approved_for_use ON growth_os.media_assets
 FOR EACH ROW EXECUTE FUNCTION growth_os.revoke_media_publications();
CREATE FUNCTION growth_os.protect_publishing_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.object_key,NEW.sha256,NEW.mime_type,NEW.byte_size,NEW.workspace_id,NEW.media_asset_id)
 IS DISTINCT FROM (OLD.object_key,OLD.sha256,OLD.mime_type,OLD.byte_size,OLD.workspace_id,OLD.media_asset_id)
 OR (OLD.state='revoked' AND NEW.state<>'revoked') THEN
  RAISE EXCEPTION 'Publishing bytes and revoked versions are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_publishing_bytes_immutable BEFORE UPDATE ON growth_os.publishing_assets
 FOR EACH ROW EXECUTE FUNCTION growth_os.protect_publishing_bytes();
COMMIT;
