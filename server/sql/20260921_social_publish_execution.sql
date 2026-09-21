-- Additive execution guards. No jobs are approved, dispatched, or migrated into publishing.
BEGIN;
ALTER TABLE growth_os.social_publish_jobs
 ADD COLUMN approved_account_id text,
 ADD COLUMN execution_copy text,
 ADD COLUMN deduplication_key text CHECK (deduplication_key IS NULL OR deduplication_key ~ '^[a-f0-9]{64}$'),
 ADD COLUMN execution_state text NOT NULL DEFAULT 'not_started' CHECK(execution_state IN ('not_started','in_flight','succeeded','rejected','unknown')),
 ADD COLUMN retry_after timestamptz,
 ADD COLUMN last_provider_http_status integer;
CREATE UNIQUE INDEX growth_social_publish_deduplication ON growth_os.social_publish_jobs(workspace_id,deduplication_key) WHERE deduplication_key IS NOT NULL;
COMMIT;
