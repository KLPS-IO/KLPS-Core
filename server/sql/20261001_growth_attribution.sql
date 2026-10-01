BEGIN;
-- Raw, consented first-party visits. Reporting is derived from these and the
-- canonical public.waitlist_signups relation; metrics snapshots are not truth.
CREATE TABLE growth_os.tracked_link_visits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
 tracked_link_id uuid NOT NULL REFERENCES growth_os.tracked_links(id) ON DELETE RESTRICT,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 platform text,
 campaign_id uuid,
 content_item_id uuid,
 consent_version text NOT NULL CHECK (consent_version = 'first-party-v1'),
 visited_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
 CHECK (expires_at > visited_at)
);
CREATE INDEX tracked_link_visits_workspace_time ON growth_os.tracked_link_visits(workspace_id,visited_at);
ALTER TABLE public.waitlist_signups ADD COLUMN acquisition_visit_id uuid REFERENCES growth_os.tracked_link_visits(id) ON DELETE RESTRICT;
CREATE INDEX waitlist_acquisition_visit ON public.waitlist_signups(acquisition_visit_id) WHERE acquisition_visit_id IS NOT NULL;
-- Existing email uniqueness stays canonical. Do not backfill historical attribution.
COMMENT ON COLUMN public.waitlist_signups.acquisition_visit_id IS 'First signup only; null means unknown/unattributed, including historical records. Qualification is separate.';
CREATE FUNCTION growth_os.preserve_waitlist_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.acquisition_visit_id IS DISTINCT FROM OLD.acquisition_visit_id THEN
  RAISE EXCEPTION 'First signup attribution cannot be overwritten';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_waitlist_acquisition BEFORE UPDATE ON public.waitlist_signups
 FOR EACH ROW EXECUTE FUNCTION growth_os.preserve_waitlist_acquisition();
COMMIT;
