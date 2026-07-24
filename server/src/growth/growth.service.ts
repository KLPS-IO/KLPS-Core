import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db = Pick<PoolClient, "query">;
type Input = Record<string, unknown>;
type FieldKind = "text" | "date" | "timestamp" | "number" | "integer" | "json" | "boolean" | "uuid";
type ResourceConfig = {
  table: string;
  fields: Record<string, FieldKind>;
  required: string[];
  enums?: Record<string, readonly string[]>;
  defaultOrder?: string;
};

export const GROWTH_RESOURCES = {
  sprints: {
    table: "sprints", required: ["name"], defaultOrder: "created_at DESC",
    fields: { name: "text", objective: "text", description: "text", status: "text", start_date: "date", end_date: "date", target_metrics: "json" },
    enums: { status: ["draft", "active", "completed", "archived"] }
  },
  campaigns: {
    table: "campaigns", required: ["name"], defaultOrder: "created_at DESC",
    fields: { sprint_id: "uuid", name: "text", objective: "text", audience: "text", core_message: "text", status: "text", start_date: "date", end_date: "date" },
    enums: { status: ["draft", "preparing", "active", "paused", "completed", "archived"] }
  },
  missions: {
    table: "daily_missions", required: ["title", "mission_date"], defaultOrder: "mission_date DESC, created_at DESC",
    fields: { sprint_id: "uuid", campaign_id: "uuid", title: "text", description: "text", reason: "text", expected_outcome: "text", estimated_minutes: "integer", priority: "text", mission_date: "date", status: "text", completed_at: "timestamp" },
    enums: { priority: ["low", "medium", "high", "urgent"], status: ["planned", "active", "completed", "skipped"] }
  },
  content: {
    table: "content_items", required: ["title", "content_type"], defaultOrder: "created_at DESC",
    fields: { sprint_id: "uuid", campaign_id: "uuid", title: "text", content_type: "text", platform: "text", pillar: "text", customer_question_id: "uuid", status: "text", hook: "text", research_notes: "text", talking_points: "text", script: "text", caption: "text", call_to_action: "text", scheduled_at: "timestamp", published_at: "timestamp", external_post_url: "text", result_summary: "text", repurpose_notes: "text" },
    enums: { status: ["idea", "research", "talking_points", "script", "record", "edit", "scheduled", "published", "results", "repurpose", "archived"] }
  },
  questions: {
    table: "customer_questions", required: ["question"], defaultOrder: "created_at DESC",
    fields: { question: "text", theme: "text", source: "text", priority: "text", status: "text", usage_count: "integer" },
    enums: { priority: ["low", "medium", "high", "urgent"], status: ["new", "approved", "used", "archived"] }
  },
  metrics: {
    table: "metric_snapshots", required: ["platform", "snapshot_date"], defaultOrder: "snapshot_date DESC, created_at DESC",
    fields: { platform: "text", snapshot_date: "date", followers: "integer", reach: "integer", impressions: "integer", profile_visits: "integer", engagement_count: "integer", engagement_rate: "number", video_views: "integer", average_watch_time_seconds: "number", shares: "integer", saves: "integer", comments: "integer", posts_published: "integer", waitlist_signups_attributed: "integer", notes: "text" },
    enums: { platform: ["tiktok", "instagram", "linkedin", "website", "waitlist", "combined"] }
  },
  goals: {
    table: "goals", required: ["metric_key", "label", "target_value"], defaultOrder: "created_at DESC",
    fields: { sprint_id: "uuid", metric_key: "text", label: "text", starting_value: "number", target_value: "number", current_value: "number", start_date: "date", target_date: "date", status: "text" },
    enums: { status: ["active", "achieved", "missed", "archived"] }
  },
  insights: {
    table: "insights", required: ["category", "title"], defaultOrder: "created_at DESC",
    fields: { sprint_id: "uuid", category: "text", title: "text", evidence: "text", recommended_decision: "text", confidence: "number", source_type: "text", status: "text" },
    enums: { source_type: ["manual", "calculated"], status: ["active", "actioned", "archived"] }
  },
  calendar: {
    table: "calendar_entries", required: ["title", "entry_type", "starts_at"], defaultOrder: "starts_at ASC",
    fields: { content_item_id: "uuid", title: "text", entry_type: "text", starts_at: "timestamp", ends_at: "timestamp", platform: "text", status: "text", notes: "text" },
    enums: { entry_type: ["filming", "editing", "publishing", "campaign", "review", "newsletter", "community"], status: ["planned", "completed", "cancelled"] }
  },
  media: {
    table: "media_assets", required: ["filename", "display_name", "asset_type"], defaultOrder: "created_at DESC",
    fields: { filename: "text", display_name: "text", asset_type: "text", mime_type: "text", storage_key: "text", thumbnail_reference: "text", tags: "json", approved_for_use: "boolean", notes: "text" }
  }
} satisfies Record<string, ResourceConfig>;

export type GrowthResource = keyof typeof GROWTH_RESOURCES;

const growthError = (message: string, code = "invalid_growth_payload", statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const parseField = (field: string, kind: FieldKind, value: unknown) => {
  if (value === null || value === "") return null;
  if (kind === "text") {
    if (typeof value !== "string") throw growthError(`${field} must be a string`);
    return value.trim() || null;
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") throw growthError(`${field} must be a boolean`);
    return value;
  }
  if (kind === "json") {
    if (typeof value !== "object" || value === null) throw growthError(`${field} must be an object or array`);
    return value;
  }
  if (kind === "uuid") {
    if (typeof value !== "string" || !uuidPattern.test(value)) throw growthError(`${field} must be a UUID`);
    return value;
  }
  if (kind === "date") {
    if (typeof value !== "string" || !datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw growthError(`${field} must be YYYY-MM-DD`);
    return value;
  }
  if (kind === "timestamp") {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw growthError(`${field} must be an ISO timestamp`);
    return value;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || (kind === "integer" && (!Number.isInteger(parsed) || parsed < 0))) throw growthError(`${field} must be ${kind === "integer" ? "a non-negative integer" : "a number"}`);
  return parsed;
};

export const validateGrowthPayload = (resource: GrowthResource, input: Input, partial = false) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw growthError("Request body must be an object");
  const config: ResourceConfig = GROWTH_RESOURCES[resource];
  const unknown = Object.keys(input).filter(field => !(field in config.fields));
  if (unknown.length) throw growthError(`Unknown fields: ${unknown.join(", ")}`);
  const output: Input = {};
  for (const [field, kind] of Object.entries(config.fields)) {
    if (field in input) output[field] = parseField(field, kind, input[field]);
  }
  if (!partial) {
    for (const field of config.required) {
      if (!(field in output) || output[field] === null) throw growthError(`${field} is required`);
    }
  }
  for (const [field, allowed] of Object.entries(config.enums ?? {})) {
    if (field in output && output[field] !== null && !allowed.includes(output[field] as string)) throw growthError(`Invalid ${field}`);
  }
  if ("confidence" in output && output.confidence !== null && (Number(output.confidence) < 0 || Number(output.confidence) > 1)) throw growthError("confidence must be between 0 and 1");
  return output;
};

export const requireFounderGrowth = (role: unknown) => {
  if (role !== "founder_admin") throw growthError("Founder/admin access is required", "growth_forbidden", 403);
};

export const ensureWorkspace = async (userId: string, db: Db = pool) => {
  const result = await db.query(
    `INSERT INTO growth_os.workspaces(owner_user_id,name,timezone) VALUES($1,'KLPS Growth OS','Europe/London')
     ON CONFLICT(owner_user_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id RETURNING *`,
    [userId]
  );
  await db.query(`INSERT INTO growth_os.strategy(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO NOTHING`, [result.rows[0].id]);
  return result.rows[0];
};

export const updateWorkspace = async (workspaceId: string, input: Input, db: Db = pool) => {
  const allowed: Record<string, FieldKind> = { name: "text", timezone: "text", preferred_working_days: "json", default_platforms: "json", default_content_duration: "integer", notification_preferences: "json" };
  const unknown = Object.keys(input).filter(field => !(field in allowed));
  if (unknown.length) throw growthError(`Unknown fields: ${unknown.join(", ")}`);
  const value: Input = {};
  for (const [field, kind] of Object.entries(allowed)) if (field in input) value[field] = parseField(field, kind, input[field]);
  if (!Object.keys(value).length) throw growthError("No workspace fields supplied");
  return updateRow("workspaces", workspaceId, workspaceId, value, db, false);
};

const updateRow = async (table: string, workspaceId: string, id: string, value: Input, db: Db, scopeWorkspace = true) => {
  const names = Object.keys(value);
  if (!names.length) throw growthError("No fields supplied");
  const params = names.map(name => value[name]);
  params.push(id);
  let where = `id = $${params.length}`;
  if (scopeWorkspace) {
    params.push(workspaceId);
    where += ` AND workspace_id = $${params.length}`;
  }
  const result = await db.query(`UPDATE growth_os.${table} SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")} WHERE ${where} RETURNING *`, params);
  if (!result.rows[0]) throw growthError("Growth OS record not found", "growth_record_not_found", 404);
  return result.rows[0];
};

export const getStrategy = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`SELECT * FROM growth_os.strategy WHERE workspace_id=$1`, [workspaceId]);
  return result.rows[0];
};

export const updateStrategy = async (workspaceId: string, input: Input, db: Db = pool) => {
  const allowed: Record<string, FieldKind> = { objective: "text", target_audience: "text", core_message: "text", customer_problem: "text", brand_principles: "json", content_pillars: "json", success_metrics: "json" };
  const unknown = Object.keys(input).filter(field => !(field in allowed));
  if (unknown.length) throw growthError(`Unknown fields: ${unknown.join(", ")}`);
  const value: Input = {};
  for (const [field, kind] of Object.entries(allowed)) if (field in input) value[field] = parseField(field, kind, input[field]);
  const names = Object.keys(value);
  if (!names.length) throw growthError("No strategy fields supplied");
  const params = names.map(name => value[name]);
  params.push(workspaceId);
  const result = await db.query(`UPDATE growth_os.strategy SET ${names.map((name, index) => `${name}=$${index + 1}`).join(", ")} WHERE workspace_id=$${params.length} RETURNING *`, params);
  return result.rows[0];
};

export const listGrowthRecords = async (resource: GrowthResource, workspaceId: string, filters: Input, db: Db = pool) => {
  const config: ResourceConfig = GROWTH_RESOURCES[resource];
  const where = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  for (const field of ["status", "sprint_id", "campaign_id", "platform"] as const) {
    if (field in config.fields && typeof filters[field] === "string" && filters[field]) {
      params.push(parseField(field, config.fields[field], filters[field]));
      where.push(`${field} = $${params.length}`);
    }
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const result = await db.query(`SELECT * FROM growth_os.${config.table} WHERE ${where.join(" AND ")} ORDER BY ${config.defaultOrder} LIMIT $${params.length}`, params);
  return result.rows;
};

export const getGrowthRecord = async (resource: GrowthResource, workspaceId: string, id: string, db: Db = pool) => {
  if (!uuidPattern.test(id)) throw growthError("Invalid record id");
  const result = await db.query(`SELECT * FROM growth_os.${GROWTH_RESOURCES[resource].table} WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  if (!result.rows[0]) throw growthError("Growth OS record not found", "growth_record_not_found", 404);
  return result.rows[0];
};

export const createGrowthRecord = async (resource: GrowthResource, workspaceId: string, input: Input, db: Db = pool) => {
  const config: ResourceConfig = GROWTH_RESOURCES[resource];
  const value = validateGrowthPayload(resource, input);
  const names = Object.keys(value);
  const params = [workspaceId, ...names.map(name => value[name])];
  if (resource === "metrics") {
    const updates = names.filter(name => !["platform", "snapshot_date"].includes(name));
    const result = await db.query(
      `INSERT INTO growth_os.metric_snapshots(workspace_id,${names.join(",")}) VALUES(${params.map((_, index) => `$${index + 1}`).join(",")})
       ON CONFLICT(workspace_id,platform,snapshot_date) DO UPDATE SET ${updates.map(name => `${name}=EXCLUDED.${name}`).join(",") || "updated_at=now()"} RETURNING *`,
      params
    );
    return result.rows[0];
  }
  try {
    const result = await db.query(`INSERT INTO growth_os.${config.table}(workspace_id,${names.join(",")}) VALUES(${params.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`, params);
    return result.rows[0];
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505" && resource === "sprints") throw growthError("Only one sprint may be active per workspace", "active_sprint_conflict", 409);
    throw cause;
  }
};

export const updateGrowthRecord = async (resource: GrowthResource, workspaceId: string, id: string, input: Input, db: Db = pool) => {
  const value = validateGrowthPayload(resource, input, true);
  if (resource === "missions" && value.status === "completed" && !("completed_at" in value)) value.completed_at = new Date().toISOString();
  if (resource === "missions" && value.status !== undefined && value.status !== "completed") value.completed_at = null;
  try {
    return await updateRow(GROWTH_RESOURCES[resource].table, workspaceId, id, value, db);
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505" && resource === "sprints") throw growthError("Only one sprint may be active per workspace", "active_sprint_conflict", 409);
    throw cause;
  }
};

export const deleteGrowthRecord = async (resource: GrowthResource, workspaceId: string, id: string, db: Db = pool) => {
  if (resource === "metrics") throw growthError("Historical metrics must be corrected, not deleted", "growth_delete_forbidden", 409);
  const result = await db.query(`DELETE FROM growth_os.${GROWTH_RESOURCES[resource].table} WHERE id=$1 AND workspace_id=$2 RETURNING *`, [id, workspaceId]);
  if (!result.rows[0]) throw growthError("Growth OS record not found", "growth_record_not_found", 404);
  return result.rows[0];
};

export type MetricPoint = { platform: string; snapshot_date: string; [key: string]: unknown };
const METRIC_KEYS = ["followers", "reach", "impressions", "profile_visits", "engagement_count", "engagement_rate", "video_views", "average_watch_time_seconds", "shares", "saves", "comments", "posts_published", "waitlist_signups_attributed"];
export const compareMetricValues = (latest: unknown, previous: unknown) => {
  if (latest === null || latest === undefined) return { latest: null, absolute_change: null, percentage_change: null };
  const current = Number(latest);
  if (!Number.isFinite(current)) return { latest: null, absolute_change: null, percentage_change: null };
  if (previous === null || previous === undefined || !Number.isFinite(Number(previous))) return { latest: current, absolute_change: null, percentage_change: null };
  const prior = Number(previous);
  return { latest: current, absolute_change: current - prior, percentage_change: prior === 0 ? null : ((current - prior) / Math.abs(prior)) * 100 };
};

export const summariseMetrics = (rows: MetricPoint[]) => {
  const byPlatform: Record<string, unknown> = {};
  for (const platform of [...new Set(rows.map(row => row.platform))]) {
    const snapshots = rows.filter(row => row.platform === platform).sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
    const latest = snapshots[0];
    const previous = snapshots[1];
    byPlatform[platform] = {
      snapshot_date: latest.snapshot_date,
      previous_snapshot_date: previous?.snapshot_date ?? null,
      metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, compareMetricValues(latest[key], previous?.[key])]))
    };
  }
  return { platform_breakdown: byPlatform, latest_totals: byPlatform.combined ?? null, trend_window_days: 7 };
};

export type CoachData = {
  now: Date; scheduledCount: number; lastPublishedAt: string | null; activeSprintId: string | null;
  activeGoalCount: number; lastMetricDate: string | null; stuckContent?: { id: string; title: string } | null;
  highPriorityQuestion?: { id: string; question: string } | null;
};
export const deterministicCoach = (data: CoachData) => {
  const dayMs = 86400000;
  if (data.scheduledCount === 0) return { title: "Schedule the next content item", explanation: "No content is scheduled in the next three days.", action_type: "schedule_content", related_record_id: null, priority: "high", estimated_minutes: 15 };
  if (!data.lastPublishedAt || data.now.getTime() - new Date(data.lastPublishedAt).getTime() >= 4 * dayMs) return { title: "Publish ready content", explanation: "No post has been published in the last four days.", action_type: "publish_content", related_record_id: null, priority: "high", estimated_minutes: 30 };
  if (data.activeSprintId && data.activeGoalCount === 0) return { title: "Define a measurable sprint goal", explanation: "The active sprint has no active measurable goal.", action_type: "create_goal", related_record_id: data.activeSprintId, priority: "high", estimated_minutes: 10 };
  if (!data.lastMetricDate || data.now.getTime() - new Date(`${data.lastMetricDate}T00:00:00Z`).getTime() >= 7 * dayMs) return { title: "Add the weekly metrics", explanation: "No metric snapshot has been entered in the last seven days.", action_type: "add_metrics", related_record_id: null, priority: "medium", estimated_minutes: 10 };
  if (data.stuckContent) return { title: "Move stalled content forward", explanation: `${data.stuckContent.title} has not moved for more than seven days.`, action_type: "progress_content", related_record_id: data.stuckContent.id, priority: "medium", estimated_minutes: 20 };
  if (data.highPriorityQuestion) return { title: "Turn a customer question into content", explanation: data.highPriorityQuestion.question, action_type: "create_content", related_record_id: data.highPriorityQuestion.id, priority: "medium", estimated_minutes: 20 };
  return { title: "Continue the active plan", explanation: "No urgent growth-system gaps were detected.", action_type: "review_plan", related_record_id: null, priority: "low", estimated_minutes: 10 };
};

const coachData = async (workspaceId: string, now: Date, db: Db) => {
  const result = await db.query(
    `SELECT
      (SELECT count(*)::int FROM growth_os.content_items WHERE workspace_id=$1 AND scheduled_at BETWEEN $2 AND $2::timestamptz + interval '3 days') scheduled_count,
      (SELECT max(published_at) FROM growth_os.content_items WHERE workspace_id=$1 AND published_at IS NOT NULL) last_published_at,
      (SELECT id FROM growth_os.sprints WHERE workspace_id=$1 AND status='active' LIMIT 1) active_sprint_id,
      (SELECT count(*)::int FROM growth_os.goals WHERE workspace_id=$1 AND status='active') active_goal_count,
      (SELECT max(snapshot_date) FROM growth_os.metric_snapshots WHERE workspace_id=$1) last_metric_date,
      (SELECT row_to_json(c) FROM (SELECT id,title FROM growth_os.content_items WHERE workspace_id=$1 AND status NOT IN ('published','archived') AND updated_at < $2::timestamptz - interval '7 days' ORDER BY updated_at LIMIT 1) c) stuck_content,
      (SELECT row_to_json(q) FROM (SELECT id,question FROM growth_os.customer_questions WHERE workspace_id=$1 AND priority IN ('high','urgent') AND status IN ('new','approved') ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at LIMIT 1) q) high_priority_question`,
    [workspaceId, now.toISOString()]
  );
  const row = result.rows[0];
  return {
    now, scheduledCount: row.scheduled_count, lastPublishedAt: row.last_published_at,
    activeSprintId: row.active_sprint_id, activeGoalCount: row.active_goal_count,
    lastMetricDate: row.last_metric_date, stuckContent: row.stuck_content, highPriorityQuestion: row.high_priority_question
  } as CoachData;
};

export const getMetricsSummary = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`SELECT * FROM growth_os.metric_snapshots WHERE workspace_id=$1 ORDER BY platform,snapshot_date DESC`, [workspaceId]);
  return summariseMetrics(result.rows);
};

export const getMissionControl = async (workspaceId: string, now = new Date(), db: Db = pool) => {
  const date = now.toISOString().slice(0, 10);
  const [sprint, campaign, mission, goals, metrics, opportunities, coach] = await Promise.all([
    db.query(`SELECT * FROM growth_os.sprints WHERE workspace_id=$1 AND status='active' LIMIT 1`, [workspaceId]),
    db.query(`SELECT * FROM growth_os.campaigns WHERE workspace_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [workspaceId]),
    db.query(`SELECT * FROM growth_os.daily_missions WHERE workspace_id=$1 AND mission_date=$2 AND status IN ('active','planned') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at LIMIT 1`, [workspaceId, date]),
    db.query(`SELECT * FROM growth_os.goals WHERE workspace_id=$1 AND status='active' ORDER BY target_date NULLS LAST`, [workspaceId]),
    getMetricsSummary(workspaceId, db),
    db.query(`SELECT id,'content' AS type,title,
      (CASE WHEN status IN ('record','edit','scheduled') THEN 30 ELSE 10 END + CASE WHEN updated_at < now()-interval '7 days' THEN 15 ELSE 0 END) AS score,
      CASE WHEN status IN ('record','edit','scheduled') THEN 'Ready to move closer to publishing' ELSE 'Aligned content work' END AS reason
      FROM growth_os.content_items WHERE workspace_id=$1 AND status NOT IN ('published','archived')
      ORDER BY score DESC,created_at LIMIT 5`, [workspaceId]),
    coachData(workspaceId, now, db).then(deterministicCoach)
  ]);
  const activeGoals = goals.rows;
  const progress = {
    active_goals: activeGoals.length,
    achieved_goals: activeGoals.filter(goal => goal.current_value !== null && Number(goal.current_value) >= Number(goal.target_value)).length,
    goals_with_progress: activeGoals.map(goal => ({
      id: goal.id, label: goal.label, current_value: goal.current_value, target_value: goal.target_value,
      progress_percentage: goal.current_value === null || goal.target_value === null || Number(goal.target_value) === 0 ? null : Math.min(100, (Number(goal.current_value) / Number(goal.target_value)) * 100)
    }))
  };
  const latestMetrics = (metrics.latest_totals as {
    metrics?: Record<string, { latest?: number | null }>
  } | null)?.metrics;
  const growthSnapshot = {
    followers: latestMetrics?.followers?.latest ?? null,
    reach: latestMetrics?.reach?.latest ?? null,
    engagement_rate: latestMetrics?.engagement_rate?.latest ?? null,
    posts_published: latestMetrics?.posts_published?.latest ?? null,
    waitlist_signups_attributed: latestMetrics?.waitlist_signups_attributed?.latest ?? null
  };
  return {
    active_sprint: sprint.rows[0] ?? null, active_campaign: campaign.rows[0] ?? null,
    today_mission: mission.rows[0] ?? null,
    growth_snapshot: growthSnapshot,
    metrics_summary: metrics,
    current_goals: activeGoals, progress_summary: progress,
    coach_message: coach, ranked_opportunities: opportunities.rows
  };
};
