-- Growth OS Phase 3: canonical waitlist relationship and influence layer.
-- This migration does not copy or mutate public.waitlist_signups.
BEGIN;

CREATE SCHEMA IF NOT EXISTS growth_os;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('growth_os.workspaces') IS NULL THEN
    RAISE EXCEPTION 'Apply 20260723_growth_os.sql before this migration';
  END IF;
  IF to_regclass('public.waitlist_signups') IS NULL THEN
    RAISE EXCEPTION 'Canonical public.waitlist_signups table is required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS growth_os.community_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  waitlist_signup_id uuid REFERENCES public.waitlist_signups(id) ON DELETE RESTRICT,
  participant_id uuid REFERENCES public.participants(id) ON DELETE SET NULL,
  relationship_stage text NOT NULL DEFAULT 'new' CHECK (relationship_stage IN (
    'new','reviewed','engaged','waitlist','research_participant','mvp_interested',
    'potential_tester','confirmed_tester','founding_member','champion','advocate',
    'inactive','opted_out'
  )),
  reviewed_at timestamptz,
  last_interaction_at timestamptz,
  next_action text,
  next_action_due_at timestamptz,
  mvp_interest_status text NOT NULL DEFAULT 'not_recorded' CHECK (mvp_interest_status IN (
    'not_recorded','interested','not_interested','follow_up_required'
  )),
  tester_status text NOT NULL DEFAULT 'not_assessed' CHECK (tester_status IN (
    'not_assessed','potential','invited','confirmed','not_suitable'
  )),
  founding_member_status text NOT NULL DEFAULT 'not_assessed' CHECK (founding_member_status IN (
    'not_assessed','potential','confirmed','inactive'
  )),
  champion_status text NOT NULL DEFAULT 'not_assessed' CHECK (champion_status IN (
    'not_assessed','potential','active','advocate','inactive'
  )),
  research_interest boolean,
  tags text[] NOT NULL DEFAULT '{}',
  founder_notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (waitlist_signup_id IS NOT NULL OR participant_id IS NOT NULL),
  UNIQUE (workspace_id, waitlist_signup_id),
  UNIQUE (workspace_id, participant_id)
);

CREATE TABLE IF NOT EXISTS growth_os.relationship_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  community_profile_id uuid NOT NULL REFERENCES growth_os.community_profiles(id) ON DELETE CASCADE,
  previous_stage text,
  new_stage text NOT NULL,
  reason text,
  changed_by uuid NOT NULL REFERENCES data_room.users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  community_profile_id uuid NOT NULL REFERENCES growth_os.community_profiles(id) ON DELETE RESTRICT,
  interaction_type text NOT NULL CHECK (interaction_type IN (
    'comment','direct_message','email','interview','event','referral',
    'partner_introduction','research_call','tester_call','other'
  )),
  channel text NOT NULL CHECK (channel IN (
    'tiktok','instagram','linkedin','email','whatsapp','website','in_person',
    'video_call','phone','other'
  )),
  occurred_at timestamptz NOT NULL,
  summary text NOT NULL,
  exact_customer_language text,
  problem_or_need text,
  objection text,
  product_interest text,
  approved_quote boolean NOT NULL DEFAULT false,
  quote_use_permission boolean NOT NULL DEFAULT false,
  linked_content_item_id uuid REFERENCES growth_os.content_items(id) ON DELETE SET NULL,
  linked_campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  linked_customer_question_id uuid REFERENCES growth_os.customer_questions(id) ON DELETE SET NULL,
  next_action text,
  follow_up_at timestamptz,
  created_by uuid NOT NULL REFERENCES data_room.users(id) ON DELETE RESTRICT,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT approved_quote OR quote_use_permission)
);

CREATE TABLE IF NOT EXISTS growth_os.follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  community_profile_id uuid NOT NULL REFERENCES growth_os.community_profiles(id) ON DELETE RESTRICT,
  interaction_id uuid REFERENCES growth_os.interactions(id) ON DELETE SET NULL,
  follow_up_type text NOT NULL CHECK (follow_up_type IN (
    'welcome','reply','interview_invitation','interview_follow_up','mvp_invitation',
    'feedback_request','referral_thank_you','quote_permission','re_engagement',
    'partner_follow_up','media_follow_up','other'
  )),
  title text NOT NULL,
  reason text,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','skipped','cancelled')),
  completed_at timestamptz,
  skipped_at timestamptz,
  notes text,
  linked_campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  linked_content_item_id uuid REFERENCES growth_os.content_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.mvp_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  community_profile_id uuid NOT NULL REFERENCES growth_os.community_profiles(id) ON DELETE RESTRICT,
  primary_problem text,
  frequency text,
  daily_life_effect text,
  current_solution text,
  money_already_spent text,
  willing_to_wear_prototype boolean,
  willing_to_give_regular_feedback boolean,
  available_for_interview boolean,
  preferred_contact_method text,
  participation_needs text,
  testing_concerns text,
  consent_to_future_testing_contact boolean,
  founder_assessment text NOT NULL DEFAULT 'not_assessed' CHECK (founder_assessment IN (
    'not_assessed','nurture','invite_to_interview','strong_potential_tester',
    'confirmed_tester','champion_potential','not_suitable_currently'
  )),
  assessment_notes text,
  assessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, community_profile_id)
);

CREATE TABLE IF NOT EXISTS growth_os.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  referrer_profile_id uuid NOT NULL REFERENCES growth_os.community_profiles(id) ON DELETE RESTRICT,
  referred_waitlist_signup_id uuid REFERENCES public.waitlist_signups(id) ON DELETE RESTRICT,
  referred_profile_id uuid REFERENCES growth_os.community_profiles(id) ON DELETE SET NULL,
  referral_source text,
  campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','joined','acknowledged','archived')),
  referred_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_os.tracked_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
  public_code text NOT NULL DEFAULT encode(gen_random_bytes(9), 'hex'),
  label text NOT NULL,
  destination_url text NOT NULL,
  source text NOT NULL,
  medium text NOT NULL,
  campaign text,
  content_item_id uuid REFERENCES growth_os.content_items(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES growth_os.campaigns(id) ON DELETE SET NULL,
  referral_code text,
  generated_url text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_code)
);

CREATE INDEX IF NOT EXISTS growth_community_waitlist ON growth_os.community_profiles(waitlist_signup_id);
CREATE INDEX IF NOT EXISTS growth_community_workspace_stage ON growth_os.community_profiles(workspace_id,relationship_stage);
CREATE INDEX IF NOT EXISTS growth_community_workspace_due ON growth_os.community_profiles(workspace_id,next_action_due_at);
CREATE INDEX IF NOT EXISTS growth_stage_history_profile_date ON growth_os.relationship_stage_history(community_profile_id,changed_at DESC);
CREATE INDEX IF NOT EXISTS growth_interactions_profile_date ON growth_os.interactions(community_profile_id,occurred_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_followups_workspace_due ON growth_os.follow_up_tasks(workspace_id,status,due_at);
CREATE INDEX IF NOT EXISTS growth_referrals_workspace_date ON growth_os.referrals(workspace_id,referred_at DESC);
CREATE INDEX IF NOT EXISTS growth_tracked_links_workspace ON growth_os.tracked_links(workspace_id,status);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'community_profiles','interactions','follow_up_tasks','mvp_qualifications',
    'referrals','tracked_links'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON growth_os.%I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON growth_os.%I FOR EACH ROW EXECUTE FUNCTION growth_os.set_updated_at()',
      table_name, table_name
    );
  END LOOP;
END $$;

COMMIT;
