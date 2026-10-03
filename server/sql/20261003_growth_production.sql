BEGIN;
-- Candidates are versions of the existing Studio record, not a second content/media system.
ALTER TABLE growth_os.content_items ADD COLUMN production_state jsonb;
ALTER TABLE growth_os.content_items ADD CONSTRAINT growth_production_object CHECK(production_state IS NULL OR jsonb_typeof(production_state)='object');
ALTER TABLE growth_os.media_assets ADD COLUMN production_provenance jsonb;
-- Direct Studio edits cannot silently retain production approvals.
CREATE FUNCTION growth_os.invalidate_production_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.production_state IS NOT NULL AND NEW.production_state IS NOT DISTINCT FROM OLD.production_state
 AND (NEW.caption IS DISTINCT FROM OLD.caption OR NEW.script IS DISTINCT FROM OLD.script
 OR (NEW.platform_brief-'asset_id') IS DISTINCT FROM (OLD.platform_brief-'asset_id')) THEN
 NEW.production_state=jsonb_set(NEW.production_state,'{candidates}',coalesce((SELECT jsonb_agg(CASE WHEN value->>'kind'='copy' OR (NEW.platform_brief-'asset_id') IS DISTINCT FROM (OLD.platform_brief-'asset_id') THEN value || '{"approved_at":null,"approved_by":null}'::jsonb ELSE value END) FROM jsonb_array_elements(NEW.production_state->'candidates')),'[]'::jsonb));
 NEW.production_state=jsonb_set(NEW.production_state,'{version}',to_jsonb((NEW.production_state->>'version')::integer+1));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_production_copy_guard BEFORE UPDATE ON growth_os.content_items FOR EACH ROW EXECUTE FUNCTION growth_os.invalidate_production_copy();
CREATE FUNCTION growth_os.invalidate_production_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
 OR NEW.provenance_kind IS DISTINCT FROM OLD.provenance_kind OR NEW.provenance_notes IS DISTINCT FROM OLD.provenance_notes
 OR NEW.aspect_ratio IS DISTINCT FROM OLD.aspect_ratio OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
 OR NEW.suitable_platforms IS DISTINCT FROM OLD.suitable_platforms THEN NEW.approved_for_use=false; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_production_media_guard BEFORE UPDATE ON growth_os.media_assets FOR EACH ROW EXECUTE FUNCTION growth_os.invalidate_production_media();
COMMIT;
