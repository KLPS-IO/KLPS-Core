BEGIN;
DROP SCHEMA IF EXISTS textile_lab CASCADE;
DROP TRIGGER IF EXISTS lema_daily_sessions_classify_insert ON lema.daily_sessions;
DROP FUNCTION IF EXISTS lema.classify_new_daily_session();
ALTER TABLE lema.daily_sessions DROP COLUMN IF EXISTS analytics_eligible,DROP COLUMN IF EXISTS analytics_population_snapshot,DROP COLUMN IF EXISTS activity_purpose;
ALTER TABLE lema.user_profiles DROP COLUMN IF EXISTS analytics_population;
COMMIT;
