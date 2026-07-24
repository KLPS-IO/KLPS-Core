import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import {
  compareMetricValues,
  createGrowthRecord,
  deterministicCoach,
  getMissionControl,
  requireFounderGrowth,
  summariseMetrics,
  updateGrowthRecord,
  validateGrowthPayload
} from "../growth/growth.service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";

test("Growth OS migration creates isolated schema, active-sprint uniqueness, indexes, and honest seed", () => {
  const migration = readFileSync(join(process.cwd(), "server/sql/20260723_growth_os.sql"), "utf8");
  assert.match(migration, /CREATE SCHEMA IF NOT EXISTS growth_os/);
  assert.match(migration, /growth_one_active_sprint[\s\S]*WHERE status = 'active'/);
  assert.match(migration, /Operation Stop Guessing/);
  assert.match(migration, /Why does my body change every week\?/);
  assert.doesNotMatch(migration, /question videos outperform|purple thumbnails|three waitlist conversions/i);
  for (const indexTarget of ["workspace", "status", "sprint", "campaign", "snapshot_date", "scheduled", "published"]) {
    assert.match(migration, new RegExp(indexTarget, "i"));
  }
});

test("Growth OS authorization permits founders and rejects other roles", () => {
  assert.doesNotThrow(() => requireFounderGrowth("founder_admin"));
  assert.throws(
    () => requireFounderGrowth("authorised_user"),
    (reason: unknown) => (reason as { code?: string; statusCode?: number }).code === "growth_forbidden" &&
      (reason as { statusCode?: number }).statusCode === 403
  );
});

test("only one active sprint per workspace returns a canonical conflict", async () => {
  const db = { query: async () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); } };
  await assert.rejects(
    createGrowthRecord("sprints", WORKSPACE_ID, { name: "Second", status: "active" }, db as never),
    (reason: unknown) => (reason as { code?: string; statusCode?: number }).code === "active_sprint_conflict" &&
      (reason as { statusCode?: number }).statusCode === 409
  );
});

test("content workflow updates one canonical content record", async () => {
  let sql = "";
  let params: unknown[] = [];
  const db = { query: async (query: string, values?: unknown[]) => {
    sql = query;
    params = values ?? [];
    return { rows: [{ id: RECORD_ID, status: "script", script: "Canonical script" }] };
  }};
  const row = await updateGrowthRecord("content", WORKSPACE_ID, RECORD_ID, { status: "script", script: "Canonical script" }, db as never);
  assert.match(sql, /UPDATE growth_os\.content_items/);
  assert.doesNotMatch(sql, /INSERT/);
  assert.deepEqual(params, ["script", "Canonical script", RECORD_ID, WORKSPACE_ID]);
  assert.equal(row.status, "script");
});

test("mission completion sets completed_at on the same mission", async () => {
  let sql = "";
  let params: unknown[] = [];
  const db = { query: async (query: string, values?: unknown[]) => {
    sql = query;
    params = values ?? [];
    return { rows: [{ id: RECORD_ID, status: "completed", completed_at: values?.[1] }] };
  }};
  const row = await updateGrowthRecord("missions", WORKSPACE_ID, RECORD_ID, { status: "completed" }, db as never);
  assert.match(sql, /UPDATE growth_os\.daily_missions/);
  assert.equal(params[0], "completed");
  assert.equal(typeof params[1], "string");
  assert.equal(row.status, "completed");
});

test("manual metrics create or correct the unique platform-date snapshot", async () => {
  let sql = "";
  const db = { query: async (query: string) => {
    sql = query;
    return { rows: [{ id: RECORD_ID, platform: "instagram", snapshot_date: "2026-07-23", followers: 20 }] };
  }};
  const row = await createGrowthRecord("metrics", WORKSPACE_ID, {
    platform: "instagram", snapshot_date: "2026-07-23", followers: 20
  }, db as never);
  assert.match(sql, /ON CONFLICT\(workspace_id,platform,snapshot_date\) DO UPDATE/);
  assert.equal(row.followers, 20);
});

test("metric comparisons preserve unavailable values and suppress zero-baseline percentages", () => {
  assert.deepEqual(compareMetricValues(null, 10), { latest: null, absolute_change: null, percentage_change: null });
  assert.deepEqual(compareMetricValues(10, 0), { latest: 10, absolute_change: 10, percentage_change: null });
  assert.deepEqual(compareMetricValues(15, 10), { latest: 15, absolute_change: 5, percentage_change: 50 });
  const summary = summariseMetrics([
    { platform: "linkedin", snapshot_date: "2026-07-23", followers: 15 },
    { platform: "linkedin", snapshot_date: "2026-07-16", followers: 10 }
  ]);
  assert.deepEqual(
    (summary.platform_breakdown.linkedin as { metrics: { followers: unknown } }).metrics.followers,
    { latest: 15, absolute_change: 5, percentage_change: 50 }
  );
});

test("deterministic coach applies saved-data rules without claiming AI", () => {
  const now = new Date("2026-07-23T12:00:00Z");
  assert.equal(deterministicCoach({
    now, scheduledCount: 0, lastPublishedAt: now.toISOString(), activeSprintId: null,
    activeGoalCount: 0, lastMetricDate: "2026-07-23"
  }).action_type, "schedule_content");
  assert.equal(deterministicCoach({
    now, scheduledCount: 1, lastPublishedAt: "2026-07-18T12:00:00Z", activeSprintId: null,
    activeGoalCount: 0, lastMetricDate: "2026-07-23"
  }).action_type, "publish_content");
  assert.equal(deterministicCoach({
    now, scheduledCount: 1, lastPublishedAt: now.toISOString(), activeSprintId: RECORD_ID,
    activeGoalCount: 0, lastMetricDate: "2026-07-23"
  }).action_type, "create_goal");
});

test("mission control composes operational data in one response", async () => {
  const db = { query: async (sql: string) => {
    if (sql.includes("scheduled_count")) return { rows: [{
      scheduled_count: 1, last_published_at: "2026-07-23T10:00:00Z", active_sprint_id: RECORD_ID,
      active_goal_count: 1, last_metric_date: "2026-07-23", stuck_content: null, high_priority_question: null
    }] };
    if (sql.includes("FROM growth_os.sprints")) return { rows: [{ id: RECORD_ID, name: "Operation Stop Guessing" }] };
    if (sql.includes("FROM growth_os.campaigns")) return { rows: [{ id: RECORD_ID, name: "Campaign" }] };
    if (sql.includes("FROM growth_os.daily_missions")) return { rows: [{ id: RECORD_ID, title: "Mission" }] };
    if (sql.includes("FROM growth_os.goals")) return { rows: [{ id: RECORD_ID, label: "Reach", current_value: 5, target_value: 10 }] };
    if (sql.includes("FROM growth_os.metric_snapshots")) return { rows: [{ platform: "combined", snapshot_date: "2026-07-23", reach: 5 }] };
    if (sql.includes("'content' AS type")) return { rows: [{ id: RECORD_ID, type: "content", score: 30, reason: "Ready" }] };
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result = await getMissionControl(WORKSPACE_ID, new Date("2026-07-23T12:00:00Z"), db as never);
  assert.equal(result.active_sprint.name, "Operation Stop Guessing");
  assert.equal(result.today_mission.title, "Mission");
  assert.equal(result.current_goals.length, 1);
  assert.equal(result.progress_summary.goals_with_progress[0].progress_percentage, 50);
  assert.equal(result.ranked_opportunities.length, 1);
  assert.equal(result.coach_message.action_type, "review_plan");
  assert.deepEqual(result.growth_snapshot, {
    followers: null,
    reach: 5,
    engagement_rate: null,
    posts_published: null,
    waitlist_signups_attributed: null
  });
});

test("Growth OS validates required, enum, unknown, date, and confidence fields", () => {
  assert.throws(() => validateGrowthPayload("content", { title: "Missing type" }), /content_type is required/);
  assert.throws(() => validateGrowthPayload("content", { title: "X", content_type: "video", status: "invented" }), /Invalid status/);
  assert.throws(() => validateGrowthPayload("goals", { metric_key: "reach", label: "Reach", target_value: 10, fake: true }), /Unknown fields/);
  assert.throws(() => validateGrowthPayload("missions", { title: "X", mission_date: "tomorrow" }), /YYYY-MM-DD/);
  assert.throws(() => validateGrowthPayload("insights", { category: "learning", title: "X", confidence: 2 }), /between 0 and 1/);
});

test("Growth OS is mounted as an isolated route without replacing existing routes", () => {
  const index = readFileSync(join(process.cwd(), "server/src/index.ts"), "utf8");
  assert.match(index, /app\.use\("\/api\/growth", growthRoutes\)/);
  for (const existing of ["/api/data-room", "/api/finance", "/api/research", "/api/waitlist"]) {
    assert.match(index, new RegExp(`app\\.use\\("${existing.replace("/", "\\/")}`));
  }
});
