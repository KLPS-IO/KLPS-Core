BEGIN;
ALTER TABLE growth_os.campaigns
 ADD COLUMN narrative_opportunity_id uuid UNIQUE REFERENCES growth_os.narrative_opportunities(id) ON DELETE RESTRICT,
 ADD COLUMN narrative_plan jsonb,
 ADD COLUMN planning_version integer NOT NULL DEFAULT 1,
 ADD COLUMN planning_approved_at timestamptz,
 ADD COLUMN planning_approved_by uuid REFERENCES data_room.users(id);
ALTER TABLE growth_os.content_items ADD COLUMN platform_brief jsonb;
ALTER TABLE growth_os.media_assets
 ADD COLUMN provenance_kind text NOT NULL DEFAULT 'unknown' CHECK(provenance_kind IN ('unknown','genuine_founder','genuine_product','designed','generated')),
 ADD COLUMN provenance_notes text,
 ADD COLUMN provenance_history jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN suitable_platforms jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN aspect_ratio text,
 ADD COLUMN duration_seconds integer CHECK(duration_seconds IS NULL OR duration_seconds>0);
CREATE UNIQUE INDEX growth_narrative_slot ON growth_os.content_items(campaign_id,(platform_brief->>'slot')) WHERE platform_brief IS NOT NULL;
-- Planned content owns its intended date. It cannot also own a publishing calendar row.
CREATE FUNCTION growth_os.check_planner_calendar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entry_type='publishing' AND EXISTS(SELECT 1 FROM growth_os.content_items WHERE id=NEW.content_item_id AND platform_brief IS NOT NULL) THEN
 RAISE EXCEPTION 'Narrative content owns its planned date; edit the narrative planner'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_planner_calendar_guard BEFORE INSERT OR UPDATE ON growth_os.calendar_entries FOR EACH ROW EXECUTE FUNCTION growth_os.check_planner_calendar();
COMMIT;
