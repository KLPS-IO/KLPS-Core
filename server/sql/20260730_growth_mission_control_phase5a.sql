-- Growth OS Phase 5A: advancing Mission Control metadata.
-- This migration is additive and seeds no missions or operational records.
BEGIN;

DO $$
BEGIN
  IF to_regclass('growth_os.daily_missions') IS NULL THEN
    RAISE EXCEPTION 'Required relation growth_os.daily_missions does not exist';
  END IF;
  IF to_regclass('growth_os.workspaces') IS NULL THEN
    RAISE EXCEPTION 'Required relation growth_os.workspaces does not exist';
  END IF;
END $$;

ALTER TABLE growth_os.daily_missions
  ADD COLUMN IF NOT EXISTS candidate_type text,
  ADD COLUMN IF NOT EXISTS candidate_key text,
  ADD COLUMN IF NOT EXISTS source_module text,
  ADD COLUMN IF NOT EXISTS related_entity_type text,
  ADD COLUMN IF NOT EXISTS related_entity_id uuid,
  ADD COLUMN IF NOT EXISTS completion_condition jsonb,
  ADD COLUMN IF NOT EXISTS cooldown_metadata jsonb,
  ADD COLUMN IF NOT EXISTS completion_verification text,
  ADD COLUMN IF NOT EXISTS outcome_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_close_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'growth_mission_completion_verification_check'
      AND conrelid = 'growth_os.daily_missions'::regclass
  ) THEN
    ALTER TABLE growth_os.daily_missions
      ADD CONSTRAINT growth_mission_completion_verification_check
      CHECK (
        completion_verification IS NULL
        OR completion_verification IN ('outcome_verified','manual_closed')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'growth_mission_manual_close_reason_check'
      AND conrelid = 'growth_os.daily_missions'::regclass
  ) THEN
    ALTER TABLE growth_os.daily_missions
      ADD CONSTRAINT growth_mission_manual_close_reason_check
      CHECK (
        completion_verification <> 'manual_closed'
        OR (manual_close_reason IS NOT NULL AND length(trim(manual_close_reason)) >= 5)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS growth_one_open_mission_candidate
  ON growth_os.daily_missions(workspace_id,candidate_key)
  WHERE candidate_key IS NOT NULL AND status IN ('planned','active');

CREATE INDEX IF NOT EXISTS growth_missions_candidate_history
  ON growth_os.daily_missions(workspace_id,candidate_key,updated_at DESC)
  WHERE candidate_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS growth_missions_source_module
  ON growth_os.daily_missions(workspace_id,source_module,status);

CREATE TABLE IF NOT EXISTS growth_os.mission_candidate_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE CASCADE,
  candidate_key text NOT NULL,
  candidate_type text NOT NULL,
  reason text,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS growth_candidate_dismissals_history
  ON growth_os.mission_candidate_dismissals(workspace_id,candidate_key,dismissed_at DESC);

COMMIT;

-- Verification queries (read-only; run separately after migration approval):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='growth_os' AND table_name='daily_missions'
--   AND column_name IN (
--     'candidate_type','candidate_key','source_module','related_entity_type',
--     'related_entity_id','completion_condition','cooldown_metadata',
--     'completion_verification','outcome_verified_at','manual_close_reason'
--   ) ORDER BY column_name;
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname='growth_os'
--   AND indexname IN (
--     'growth_one_open_mission_candidate',
--     'growth_missions_candidate_history',
--     'growth_missions_source_module'
--   ) ORDER BY indexname;
-- SELECT count(*) AS existing_missions FROM growth_os.daily_missions;
-- SELECT count(*) AS candidate_dismissals
-- FROM growth_os.mission_candidate_dismissals;
