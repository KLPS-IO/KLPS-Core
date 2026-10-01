BEGIN;
-- An intake/decision envelope, not a second insight or content store.
CREATE TABLE growth_os.narrative_opportunities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
 source_kind text NOT NULL CHECK(source_kind IN ('rd_discovery','rd_quotation','rd_finding','rd_delivery','community_feedback')),
 source_id uuid NOT NULL,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','dismissed','deferred','confidential','superseded')),
 proposal jsonb NOT NULL,
 founder_plan jsonb,
 deferred_until timestamptz,
 insight_id uuid UNIQUE REFERENCES growth_os.insights(id) ON DELETE RESTRICT,
 content_item_id uuid REFERENCES growth_os.content_items(id) ON DELETE SET NULL,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,source_kind,source_id,evidence_hash),
 CHECK(status <> 'accepted' OR insight_id IS NOT NULL)
);
CREATE INDEX narrative_opportunities_review ON growth_os.narrative_opportunities(workspace_id,status,created_at);
CREATE TABLE growth_os.narrative_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES growth_os.workspaces(id) ON DELETE RESTRICT,
 opportunity_id uuid NOT NULL REFERENCES growth_os.narrative_opportunities(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES data_room.users(id),
 decision text NOT NULL CHECK(decision IN ('accepted','dismissed','deferred','confidential','superseded','planned')),
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION growth_os.preserve_narrative_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Narrative decision history is append-only'; END $$;
CREATE TRIGGER preserve_narrative_decision BEFORE UPDATE OR DELETE ON growth_os.narrative_decisions
 FOR EACH ROW EXECUTE FUNCTION growth_os.preserve_narrative_decision();
COMMIT;
