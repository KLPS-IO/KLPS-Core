import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CandidateSnapshot,
  acceptMissionCandidate,
  completeMission,
  deriveMissionCandidates,
  evaluateMissionCompletion,
  getMissionCandidates
} from "../growth/mission-candidate.service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-30T10:00:00Z");

const snapshot = (changes: Partial<CandidateSnapshot> = {}): CandidateSnapshot => ({
  social_connections: [{ provider: "linkedin", status: "connected" }],
  configured_social_providers: ["linkedin"],
  content: [],
  active_campaign: null,
  active_sprint: null,
  follow_ups: [],
  unreviewed_waitlist: [],
  qualification_actions: [],
  unresolved_referrals: [],
  goals: [],
  insights: [],
  last_metric_date: "2026-07-30",
  ...changes
});

test("Phase 5A migration is transactional, additive, rerunnable, and seeds no records", () => {
  const sql = readFileSync(join(process.cwd(), "server/sql/20260730_growth_mission_control_phase5a.sql"), "utf8");
  assert.match(sql,/^--[\s\S]*BEGIN;/);
  assert.match(sql,/COMMIT;/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS candidate_key/);
  assert.match(sql,/growth_one_open_mission_candidate/);
  assert.doesNotMatch(sql,/\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql,/(?:^|\n)\s*(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i);
  assert.match(sql,/mission_candidate_dismissals/);
});

test("overdue human follow-up outranks routine schedulable content", () => {
  const candidates = deriveMissionCandidates(snapshot({
    follow_ups: [{ id: ID, due_at: "2026-07-27T10:00:00Z", priority: "high", status: "pending", person_name: "Member" }],
    content: [{
      id: "33333333-3333-4333-8333-333333333333", title: "Prepared post", status: "edit",
      scheduled_at: null, published_at: null, updated_at: NOW.toISOString(), campaign_id: null, sprint_id: null
    }]
  }), [], NOW);
  assert.equal(candidates[0].candidate_type, "complete_follow_up");
  assert.equal(candidates[0].source_module, "community");
});

test("LinkedIn connection is recommended before connection and removed afterwards", () => {
  const before = deriveMissionCandidates(snapshot({ social_connections: [] }), [], NOW);
  assert.equal(before.some(item => item.candidate_type === "connect_linkedin"), true);
  assert.equal(before.find(item => item.candidate_type === "connect_linkedin")?.expected_outcome,
    "A verified LinkedIn member connection visible in Growth OS.");
  const after = deriveMissionCandidates(snapshot(), [], NOW);
  assert.equal(after.some(item => item.candidate_type === "connect_linkedin"), false);
  assert.equal(after.some(item => /publishing permission/i.test(item.title)), false);
});

test("identity connection never implies LinkedIn publishing", () => {
  const candidates = deriveMissionCandidates(snapshot({
    social_connections: [{ provider: "linkedin", status: "connected", discovered_capabilities: ["member_identity"] }]
  }), [], NOW);
  assert.equal(candidates.some(item => /enable publishing|publishing enabled/i.test(`${item.title} ${item.description} ${item.expected_outcome}`)), false);
});

test("scheduling is not recommended without schedulable content", () => {
  const candidates = deriveMissionCandidates(snapshot({
    active_campaign: { id: ID, name: "Founder education" },
    content: [{
      id: ID, title: "Early idea", status: "idea", scheduled_at: null, published_at: null,
      updated_at: NOW.toISOString(), campaign_id: ID, sprint_id: null
    }]
  }), [], NOW);
  assert.equal(candidates.some(item => item.candidate_type === "schedule_content"), false);
  assert.equal(candidates.some(item => item.candidate_type === "prepare_campaign_content"), true);
});

test("resolved operational conditions remove their candidates", () => {
  const candidates = deriveMissionCandidates(snapshot({
    follow_ups: [{ id: ID, due_at: "2026-07-29T10:00:00Z", priority: "urgent", status: "completed" }],
    unreviewed_waitlist: []
  }), [], NOW);
  assert.equal(candidates.some(item => item.candidate_type === "complete_follow_up"), false);
});

test("completed and skipped candidates respect cooldown while urgent work can override", () => {
  const input = snapshot({
    follow_ups: [{ id: ID, due_at: "2026-07-29T10:00:00Z", priority: "urgent", status: "pending" }]
  });
  const key = `community:follow-up:${ID}`;
  const recent = deriveMissionCandidates(input, [{
    candidate_key: key, status: "completed", completion_verification: "outcome_verified",
    completed_at: "2026-07-30T09:00:00Z", updated_at: "2026-07-30T09:00:00Z"
  }], NOW);
  assert.equal(recent.some(item => item.deduplication_key === key), false);
  const urgentOverride = deriveMissionCandidates(input, [{
    candidate_key: key, status: "skipped", completed_at: null,
    updated_at: "2026-07-28T09:00:00Z"
  }], NOW);
  assert.equal(urgentOverride.some(item => item.deduplication_key === key), true);
});

test("completion evaluator verifies saved content scheduling outcome", async () => {
  const db = { query: async (sql: string) => {
    assert.match(sql,/scheduled_at IS NOT NULL/);
    return { rows: [{ satisfied: true }] };
  }};
  const result = await evaluateMissionCompletion(WORKSPACE_ID, {
    completion_condition: { evaluator: "content_scheduled", id: ID }
  }, NOW, db as never);
  assert.deepEqual(result, { satisfied: true, message: "The saved operational outcome has been verified." });
});

test("incomplete outcome requires explicit confirmation", async () => {
  const mission = {
    id: ID, status: "active", completion_condition: { evaluator: "content_scheduled", id: ID }
  };
  const db = { query: async (sql: string) => {
    if (sql.includes("SELECT * FROM growth_os.daily_missions")) return { rows: [mission] };
    if (sql.includes("scheduled_at IS NOT NULL")) return { rows: [{ satisfied: false }] };
    throw new Error("Unexpected write");
  }};
  await assert.rejects(
    completeMission(WORKSPACE_ID, ID, {}, NOW, db as never),
    (reason: unknown) => (reason as { code?: string }).code === "mission_completion_confirmation_required"
  );
});

test("existing missions without completion metadata remain compatible through manual confirmation", async () => {
  const mission = { id: ID, status: "active", completion_condition: null };
  const db = { query: async (sql: string) => {
    if (sql.includes("SELECT * FROM growth_os.daily_missions")) return { rows: [mission] };
    throw new Error("Unexpected write");
  }};
  await assert.rejects(
    completeMission(WORKSPACE_ID, ID, {}, NOW, db as never),
    (reason: unknown) =>
      (reason as { code?: string }).code === "mission_completion_confirmation_required"
      && /no automatic outcome check/i.test((reason as Error).message)
  );
});

test("manual close persists founder reason without claiming verified outcome", async () => {
  const mission = {
    id: ID, status: "active", completion_condition: { evaluator: "content_scheduled", id: ID }
  };
  let updateValues: unknown[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT * FROM growth_os.daily_missions")) return { rows: [mission] };
    if (sql.includes("scheduled_at IS NOT NULL")) return { rows: [{ satisfied: false }] };
    if (sql.includes("UPDATE growth_os.daily_missions")) {
      updateValues = values ?? [];
      return { rows: [{ ...mission, status: "completed", completion_verification: "manual_closed" }] };
    }
    throw new Error(`Unexpected query ${sql}`);
  }};
  const result = await completeMission(
    WORKSPACE_ID, ID,
    { manual_close: true, manual_close_reason: "Completed outside the tracked workflow." },
    NOW, db as never
  );
  assert.equal(result.mission.completion_verification, "manual_closed");
  assert.equal(updateValues[3], "manual_closed");
  assert.equal(updateValues[5], "Completed outside the tracked workflow.");
});

test("verified completion records outcome verification", async () => {
  const mission = {
    id: ID, status: "active", completion_condition: { evaluator: "waitlist_reviewed", id: ID }
  };
  let updateValues: unknown[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT * FROM growth_os.daily_missions")) return { rows: [mission] };
    if (sql.includes("reviewed_at IS NOT NULL")) return { rows: [{ satisfied: true }] };
    updateValues = values ?? [];
    return { rows: [{ ...mission, status: "completed", completion_verification: "outcome_verified" }] };
  }};
  await completeMission(WORKSPACE_ID, ID, {}, NOW, db as never);
  assert.equal(updateValues[3], "outcome_verified");
  assert.equal(typeof updateValues[4], "string");
});

test("completed highest candidate reveals the next ranked recommendation", () => {
  const data = snapshot({
    unreviewed_waitlist: [{ id: ID, name: "Member" }],
    insights: [{ id: "33333333-3333-4333-8333-333333333333", title: "Insight", recommended_decision: null, status: "active" }]
  });
  const initial = deriveMissionCandidates(data, [], NOW);
  const next = deriveMissionCandidates(data, [{
    candidate_key: initial[0].deduplication_key,
    status: "completed",
    completion_verification: "outcome_verified",
    completed_at: NOW.toISOString(),
    updated_at: NOW.toISOString()
  }], NOW);
  assert.notEqual(next[0]?.deduplication_key, initial[0].deduplication_key);
});

test("duplicate active candidate acceptance returns a canonical conflict", async () => {
  const db = { query: async (sql: string) => {
    if (sql.includes("INSERT INTO growth_os.daily_missions")) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    if (sql.includes("max(snapshot_date)")) return { rows: [{ last_metric_date: "2026-07-30" }] };
    return { rows: [] };
  }};
  await assert.rejects(
    acceptMissionCandidate(WORKSPACE_ID, "social:connect:linkedin", "2026-07-30", NOW, db as never),
    (reason: unknown) => (reason as { code?: string }).code === "duplicate_active_mission_candidate"
  );
});

test("candidate engine has an honest empty state", () => {
  assert.deepEqual(deriveMissionCandidates(snapshot(), [], NOW), []);
});

test("candidate reads remain available before the Phase 5A migration", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes("information_schema.columns")) return { rows: [{ ready: false }] };
    if (sql.includes("max(snapshot_date)")) return { rows: [{ last_metric_date: "2026-07-30" }] };
    return { rows: [] };
  }};
  const candidates = await getMissionCandidates(WORKSPACE_ID, NOW, db as never);
  assert.equal(candidates.some(item => item.candidate_type === "connect_linkedin"), true);
  assert.equal(queries.some(sql => sql.includes("candidate_history")), false);
});
