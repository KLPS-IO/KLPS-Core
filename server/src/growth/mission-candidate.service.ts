export type CandidateUrgency = "low" | "medium" | "high" | "urgent";
export type CandidateSource =
  | "social"
  | "content"
  | "campaign"
  | "community"
  | "strategy"
  | "intelligence"
  | "metrics";

export type MissionCandidate = {
  candidate_type: string;
  deduplication_key: string;
  title: string;
  description: string;
  why_it_matters: string;
  expected_outcome: string;
  estimated_minutes: number;
  urgency: CandidateUrgency;
  importance: number;
  source_module: CandidateSource;
  related_entity_type: string | null;
  related_entity_id: string | null;
  completion_condition: Record<string, unknown>;
  cooldown: { completed_days: number; skipped_days: number; manual_closed_days: number };
  deadline_at: string | null;
  relationship_impact: number;
  campaign_relevance: number;
  sprint_alignment: number;
  score: number;
};

export type CandidateHistory = {
  candidate_key: string;
  status: "planned" | "active" | "completed" | "skipped";
  completion_verification?: "outcome_verified" | "manual_closed" | null;
  completed_at?: string | null;
  updated_at: string;
};

export type CandidateSnapshot = {
  social_connections: Array<{ provider: string; status: string; discovered_capabilities?: string[] }>;
  configured_social_providers: string[];
  content: Array<{
    id: string; title: string; status: string; scheduled_at: string | null; published_at: string | null;
    updated_at: string; campaign_id: string | null; sprint_id: string | null;
  }>;
  active_campaign: { id: string; name: string } | null;
  active_sprint: { id: string; name: string } | null;
  follow_ups: Array<{ id: string; due_at: string; priority: string; status: string; person_name?: string | null }>;
  unreviewed_waitlist: Array<{ id: string; name?: string | null }>;
  qualification_actions: Array<{ id: string; person_name?: string | null }>;
  unresolved_referrals: Array<{ id: string; person_name?: string | null }>;
  goals: Array<{ id: string; label: string; target_date: string | null; current_value: number | null; target_value: number }>;
  insights: Array<{ id: string; title: string; recommended_decision: string | null; status: string }>;
  last_metric_date: string | null;
};

const urgencyWeight: Record<CandidateUrgency, number> = { low: 10, medium: 30, high: 55, urgent: 80 };
const cooldowns: Record<CandidateSource, MissionCandidate["cooldown"]> = {
  social: { completed_days: 14, skipped_days: 7, manual_closed_days: 14 },
  content: { completed_days: 3, skipped_days: 1, manual_closed_days: 3 },
  campaign: { completed_days: 5, skipped_days: 2, manual_closed_days: 5 },
  community: { completed_days: 7, skipped_days: 2, manual_closed_days: 7 },
  strategy: { completed_days: 7, skipped_days: 2, manual_closed_days: 7 },
  intelligence: { completed_days: 7, skipped_days: 3, manual_closed_days: 7 },
  metrics: { completed_days: 6, skipped_days: 2, manual_closed_days: 6 }
};
const dayMs = 86_400_000;
const ageDays = (value: string, now: Date) => Math.max(0, (now.getTime() - new Date(value).getTime()) / dayMs);
const deadlineBoost = (deadline: string | null, now: Date) => {
  if (!deadline) return 0;
  const days = (new Date(deadline).getTime() - now.getTime()) / dayMs;
  if (days < 0) return Math.min(35, 20 + Math.abs(days) * 3);
  if (days <= 1) return 16;
  if (days <= 3) return 8;
  return 0;
};

type CandidateInput = Omit<MissionCandidate, "score" | "cooldown">;
const candidate = (input: CandidateInput): MissionCandidate => ({
  ...input,
  cooldown: cooldowns[input.source_module],
  score: 0
});

const contentPrepared = (status: string) =>
  ["script", "record", "edit", "scheduled", "published", "results", "repurpose"].includes(status);
const contentSchedulable = (status: string) => ["script", "record", "edit"].includes(status);

const suppressedByHistory = (
  item: MissionCandidate,
  history: CandidateHistory[],
  now: Date
) => {
  const prior = history
    .filter(record => record.candidate_key === item.deduplication_key)
    .sort((a,b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!prior) return false;
  if (prior.status === "active" || prior.status === "planned") return true;
  const elapsed = ageDays(prior.completed_at ?? prior.updated_at, now);
  const cooldown = prior.status === "skipped"
    ? item.cooldown.skipped_days
    : prior.completion_verification === "manual_closed"
      ? item.cooldown.manual_closed_days
      : item.cooldown.completed_days;
  const urgentOverride = item.urgency === "urgent" && elapsed >= Math.min(1, cooldown);
  return elapsed < cooldown && !urgentOverride;
};

export const rankMissionCandidates = (
  inputs: MissionCandidate[],
  history: CandidateHistory[],
  now = new Date()
) => inputs
  .filter(item => !suppressedByHistory(item, history, now))
  .map(item => ({
    ...item,
    score: Math.round(
      urgencyWeight[item.urgency]
      + item.importance
      + item.relationship_impact
      + item.campaign_relevance
      + item.sprint_alignment
      + deadlineBoost(item.deadline_at, now)
    )
  }))
  .sort((left,right) => right.score - left.score || left.deduplication_key.localeCompare(right.deduplication_key));

export const deriveMissionCandidates = (
  snapshot: CandidateSnapshot,
  history: CandidateHistory[] = [],
  now = new Date()
) => {
  const candidates: MissionCandidate[] = [];
  const connection = (provider: string) => snapshot.social_connections.find(item => item.provider === provider);
  const linkedIn = connection("linkedin");
  if (!linkedIn || !["connected", "unhealthy", "expired"].includes(linkedIn.status)) {
    candidates.push(candidate({
      candidate_type: "connect_linkedin",
      deduplication_key: "social:connect:linkedin",
      title: "Connect LinkedIn member identity",
      description: "Complete the approved LinkedIn member identity connection in Growth OS.",
      why_it_matters: "A verified member connection establishes the account identity without implying publishing access.",
      expected_outcome: "A verified LinkedIn member connection visible in Growth OS.",
      estimated_minutes: 10, urgency: "medium", importance: 24, source_module: "social",
      related_entity_type: "social_provider", related_entity_id: null,
      completion_condition: { evaluator: "social_connection_status", provider: "linkedin", status: "connected" },
      deadline_at: null, relationship_impact: 0, campaign_relevance: snapshot.active_campaign ? 5 : 0,
      sprint_alignment: 0
    }));
  } else if (linkedIn.status === "unhealthy" || linkedIn.status === "expired") {
    candidates.push(candidate({
      candidate_type: "restore_social_connection",
      deduplication_key: "social:restore:linkedin",
      title: "Restore the LinkedIn identity connection",
      description: "Review the unhealthy LinkedIn member connection. Publishing remains unavailable.",
      why_it_matters: "Growth OS cannot reliably identify the connected LinkedIn member while the connection is unhealthy.",
      expected_outcome: "A healthy LinkedIn member identity connection visible in Growth OS.",
      estimated_minutes: 10, urgency: "high", importance: 35, source_module: "social",
      related_entity_type: "social_connection", related_entity_id: null,
      completion_condition: { evaluator: "social_connection_status", provider: "linkedin", status: "connected" },
      deadline_at: null, relationship_impact: 0, campaign_relevance: 4, sprint_alignment: 0
    }));
  }
  for (const provider of snapshot.configured_social_providers.filter(name => name !== "linkedin")) {
    const saved = connection(provider);
    if (!saved || saved.status !== "connected") candidates.push(candidate({
      candidate_type: "connect_social_provider",
      deduplication_key: `social:connect:${provider}`,
      title: `Connect ${provider}`,
      description: `Complete the configured ${provider} account connection.`,
      why_it_matters: "A verified connection prepares truthful channel measurement and future approved workflows.",
      expected_outcome: `A verified ${provider} connection visible in Growth OS.`,
      estimated_minutes: 10, urgency: "low", importance: 12, source_module: "social",
      related_entity_type: "social_provider", related_entity_id: null,
      completion_condition: { evaluator: "social_connection_status", provider, status: "connected" },
      deadline_at: null, relationship_impact: 0, campaign_relevance: snapshot.active_campaign ? 3 : 0,
      sprint_alignment: 0
    }));
  }

  for (const task of snapshot.follow_ups.filter(item => item.status === "pending")) {
    const overdue = new Date(task.due_at).getTime() < now.getTime();
    const dueToday = task.due_at.slice(0,10) === now.toISOString().slice(0,10);
    if (!overdue && !dueToday) continue;
    candidates.push(candidate({
      candidate_type: "complete_follow_up",
      deduplication_key: `community:follow-up:${task.id}`,
      title: overdue ? "Complete an overdue founder follow-up" : "Complete today’s founder follow-up",
      description: task.person_name ? `Complete and record the follow-up with ${task.person_name}.` : "Complete and record the founder-confirmed follow-up.",
      why_it_matters: overdue ? "A promised human follow-up is overdue and should take priority over routine administration." : "A time-sensitive relationship commitment is due today.",
      expected_outcome: "A completed founder follow-up with the interaction recorded.",
      estimated_minutes: 15, urgency: overdue || task.priority === "urgent" ? "urgent" : "high",
      importance: 42, source_module: "community", related_entity_type: "follow_up_task",
      related_entity_id: task.id, completion_condition: { evaluator: "follow_up_completed", id: task.id },
      deadline_at: task.due_at, relationship_impact: 28, campaign_relevance: 0, sprint_alignment: 0
    }));
  }
  for (const person of snapshot.unreviewed_waitlist.slice(0,5)) candidates.push(candidate({
    candidate_type: "review_waitlist_member",
    deduplication_key: `community:waitlist-review:${person.id}`,
    title: "Review a new waitlist member",
    description: person.name ? `Review ${person.name} and record the appropriate relationship stage.` : "Review the waitlist member and record the appropriate relationship stage.",
    why_it_matters: "A timely review turns first-party interest into a clear, permission-aware next action.",
    expected_outcome: "A reviewed member profile with a clear relationship stage and next action.",
    estimated_minutes: 10, urgency: "high", importance: 30, source_module: "community",
    related_entity_type: "waitlist_signup", related_entity_id: person.id,
    completion_condition: { evaluator: "waitlist_reviewed", id: person.id },
    deadline_at: null, relationship_impact: 20, campaign_relevance: 0, sprint_alignment: 0
  }));
  for (const qualification of snapshot.qualification_actions) candidates.push(candidate({
    candidate_type: "review_mvp_qualification",
    deduplication_key: `community:qualification:${qualification.id}`,
    title: "Review an MVP qualification",
    description: qualification.person_name ? `Decide the next evidence-led action for ${qualification.person_name}.` : "Decide the next evidence-led action for a high-value MVP qualification.",
    why_it_matters: "Qualified first-party interest should have a clear founder decision and next action.",
    expected_outcome: "A reviewed MVP qualification with a recorded founder decision.",
    estimated_minutes: 15, urgency: "high", importance: 34, source_module: "community",
    related_entity_type: "qualification", related_entity_id: qualification.id,
    completion_condition: { evaluator: "qualification_actioned", id: qualification.id },
    deadline_at: null, relationship_impact: 22, campaign_relevance: 0, sprint_alignment: 2
  }));
  for (const referral of snapshot.unresolved_referrals) candidates.push(candidate({
    candidate_type: "resolve_referral",
    deduplication_key: `community:referral:${referral.id}`,
    title: "Resolve an open referral",
    description: referral.person_name ? `Record the next action for the referral from ${referral.person_name}.` : "Record the next action for an unresolved referral.",
    why_it_matters: "Referrals are relationship commitments and should not remain without a clear outcome.",
    expected_outcome: "A referral with a recorded status and next action.",
    estimated_minutes: 10, urgency: "high", importance: 32, source_module: "community",
    related_entity_type: "referral", related_entity_id: referral.id,
    completion_condition: { evaluator: "referral_resolved", id: referral.id },
    deadline_at: null, relationship_impact: 24, campaign_relevance: 0, sprint_alignment: 0
  }));

  const unscheduledPrepared = snapshot.content.filter(item => !item.scheduled_at && contentSchedulable(item.status));
  for (const item of unscheduledPrepared.slice(0,3)) candidates.push(candidate({
    candidate_type: "schedule_content",
    deduplication_key: `content:schedule:${item.id}`,
    title: "Schedule an approved content item",
    description: `Set a confirmed publication date for ${item.title}.`,
    why_it_matters: "Prepared content only supports the active campaign when it has a deliberate publication date.",
    expected_outcome: "One approved content item scheduled with a confirmed publication date.",
    estimated_minutes: 10, urgency: "high", importance: 30, source_module: "content",
    related_entity_type: "content_item", related_entity_id: item.id,
    completion_condition: { evaluator: "content_scheduled", id: item.id },
    deadline_at: null, relationship_impact: 0, campaign_relevance: item.campaign_id ? 15 : 5,
    sprint_alignment: item.sprint_id ? 6 : 0
  }));
  const scheduledReview = snapshot.content.filter(item => item.scheduled_at && new Date(item.scheduled_at).getTime() > now.getTime());
  for (const item of scheduledReview.filter(item => new Date(item.scheduled_at!).getTime() - now.getTime() <= dayMs).slice(0,2)) candidates.push(candidate({
    candidate_type: "review_scheduled_content",
    deduplication_key: `content:final-review:${item.id}`,
    title: "Complete the final content review",
    description: `Review ${item.title} before its scheduled publication time.`,
    why_it_matters: "A final founder review protects accuracy and brand quality before publication.",
    expected_outcome: "A scheduled content item reviewed and ready for its confirmed publication date.",
    estimated_minutes: 15, urgency: "urgent", importance: 38, source_module: "content",
    related_entity_type: "content_item", related_entity_id: item.id,
    completion_condition: { evaluator: "content_final_review", id: item.id },
    deadline_at: item.scheduled_at, relationship_impact: 0, campaign_relevance: 14,
    sprint_alignment: item.sprint_id ? 5 : 0
  }));
  const unfinished = snapshot.content.filter(item => !["published","archived"].includes(item.status));
  for (const item of unfinished.filter(item => ageDays(item.updated_at, now) >= 7).slice(0,2)) candidates.push(candidate({
    candidate_type: "progress_stalled_content",
    deduplication_key: `content:progress:${item.id}`,
    title: "Move stalled content forward",
    description: `${item.title} has not progressed for at least seven days.`,
    why_it_matters: "Finishing existing evidence-led work is usually more valuable than starting another draft.",
    expected_outcome: "The stalled content item advanced to its next documented workflow stage.",
    estimated_minutes: 20, urgency: "medium", importance: 24, source_module: "content",
    related_entity_type: "content_item", related_entity_id: item.id,
    completion_condition: { evaluator: "content_updated_after_acceptance", id: item.id },
    deadline_at: null, relationship_impact: 0, campaign_relevance: item.campaign_id ? 8 : 0,
    sprint_alignment: item.sprint_id ? 5 : 0
  }));
  if (snapshot.active_campaign && !snapshot.content.some(item => item.campaign_id === snapshot.active_campaign!.id && contentPrepared(item.status))) {
    candidates.push(candidate({
      candidate_type: "prepare_campaign_content",
      deduplication_key: `campaign:prepare-content:${snapshot.active_campaign.id}`,
      title: "Prepare content for the active campaign",
      description: `${snapshot.active_campaign.name} has no prepared content ready to schedule.`,
      why_it_matters: "Scheduling cannot happen truthfully until a campaign has content prepared for founder review.",
      expected_outcome: "One active-campaign content item prepared and ready for scheduling.",
      estimated_minutes: 30, urgency: "high", importance: 36, source_module: "campaign",
      related_entity_type: "campaign", related_entity_id: snapshot.active_campaign.id,
      completion_condition: { evaluator: "campaign_has_prepared_content", id: snapshot.active_campaign.id },
      deadline_at: null, relationship_impact: 0, campaign_relevance: 18, sprint_alignment: 5
    }));
  }
  const latestPublished = snapshot.content
    .filter(item => item.published_at)
    .sort((a,b) => b.published_at!.localeCompare(a.published_at!))[0];
  const readyToPublish = unfinished.filter(item => ["record","edit","scheduled"].includes(item.status));
  if ((!latestPublished || ageDays(latestPublished.published_at!, now) >= 4) && readyToPublish.length) candidates.push(candidate({
    candidate_type: "publish_ready_content",
    deduplication_key: "content:publish-next",
    title: "Publish the next ready content item",
    description: "Review the prepared content workflow and publish only when the selected item is approved.",
    why_it_matters: "No recent publication is recorded, while unfinished content remains available to progress.",
    expected_outcome: "One approved content item published with its publication record saved.",
    estimated_minutes: 30, urgency: "medium", importance: 25, source_module: "content",
    related_entity_type: "content_item", related_entity_id: null,
    completion_condition: { evaluator: "recent_content_published", within_days: 1 },
    deadline_at: null, relationship_impact: 0, campaign_relevance: snapshot.active_campaign ? 8 : 0,
    sprint_alignment: 3
  }));

  for (const goal of snapshot.goals) candidates.push(candidate({
    candidate_type: "progress_sprint_goal",
    deduplication_key: `strategy:goal:${goal.id}`,
    title: `Progress the sprint goal: ${goal.label}`,
    description: "Record the next evidence-backed action or update the measured goal value.",
    why_it_matters: "Mission Control should keep the active sprint tied to measurable outcomes.",
    expected_outcome: `A current, evidence-backed progress update for ${goal.label}.`,
    estimated_minutes: 15, urgency: goal.target_date && new Date(goal.target_date).getTime() <= now.getTime() + 2 * dayMs ? "high" : "medium",
    importance: 28, source_module: "strategy", related_entity_type: "goal", related_entity_id: goal.id,
    completion_condition: { evaluator: "goal_updated_after_acceptance", id: goal.id },
    deadline_at: goal.target_date, relationship_impact: 0, campaign_relevance: 0,
    sprint_alignment: snapshot.active_sprint ? 15 : 0
  }));
  for (const insight of snapshot.insights.filter(item => item.status === "active").slice(0,3)) candidates.push(candidate({
    candidate_type: "review_insight",
    deduplication_key: `intelligence:review:${insight.id}`,
    title: "Review an evidence-led insight",
    description: insight.recommended_decision || insight.title,
    why_it_matters: "Saved evidence becomes useful only when the founder records a decision or archives it.",
    expected_outcome: "An evidence-led insight with a recorded founder review state.",
    estimated_minutes: 10, urgency: "medium", importance: 22, source_module: "intelligence",
    related_entity_type: "insight", related_entity_id: insight.id,
    completion_condition: { evaluator: "insight_reviewed", id: insight.id },
    deadline_at: null, relationship_impact: 0, campaign_relevance: 3, sprint_alignment: 3
  }));
  if (!snapshot.last_metric_date || ageDays(`${snapshot.last_metric_date}T00:00:00Z`, now) >= 7) candidates.push(candidate({
    candidate_type: "add_weekly_metrics",
    deduplication_key: `metrics:weekly:${now.toISOString().slice(0,10)}`,
    title: "Add the weekly metrics",
    description: "Save the current reporting-period snapshot using confirmed platform data.",
    why_it_matters: "Current evidence is required before Growth OS can identify meaningful movement.",
    expected_outcome: "A current weekly metrics snapshot available for review.",
    estimated_minutes: 10, urgency: "medium", importance: 25, source_module: "metrics",
    related_entity_type: "metric_snapshot", related_entity_id: null,
    completion_condition: { evaluator: "current_metrics_snapshot", within_days: 7 },
    deadline_at: null, relationship_impact: 0, campaign_relevance: 2, sprint_alignment: 3
  }));

  return rankMissionCandidates(candidates, history, now);
};

const candidateError = (message: string, code: string, statusCode: number, details?: unknown) =>
  Object.assign(new Error(message), { code, statusCode, details });

export const getMissionCandidates = async (
  workspaceId: string,
  now = new Date(),
  db: Db = pool
) => {
  const phase5Schema = await db.query(`
    SELECT
      EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='growth_os'
          AND table_name='daily_missions'
          AND column_name='candidate_key'
      )
      AND to_regclass('growth_os.mission_candidate_dismissals') IS NOT NULL
      AS ready
  `);
  const historyQuery = phase5Schema.rows[0]?.ready === true
    ? db.query(`
        SELECT candidate_key,status,completion_verification,completed_at,updated_at
        FROM (
          SELECT candidate_key,status,completion_verification,completed_at,updated_at
          FROM growth_os.daily_missions
          WHERE workspace_id=$1 AND candidate_key IS NOT NULL
          UNION ALL
          SELECT candidate_key,'skipped' AS status,NULL AS completion_verification,
            NULL AS completed_at,dismissed_at AS updated_at
          FROM growth_os.mission_candidate_dismissals
          WHERE workspace_id=$1
        ) candidate_history
        ORDER BY updated_at DESC
        LIMIT 250
      `, [workspaceId])
    : Promise.resolve({ rows: [] });
  const [
    social, content, campaign, sprint, followUps, unreviewed, qualifications,
    referrals, goals, insights, metrics, history
  ] = await Promise.all([
    db.query(`SELECT provider,status,discovered_capabilities FROM growth_os.social_connections WHERE workspace_id=$1`, [workspaceId]),
    db.query(`SELECT id,title,status,scheduled_at,published_at,updated_at,campaign_id,sprint_id FROM growth_os.content_items WHERE workspace_id=$1 AND status<>'archived'`, [workspaceId]),
    db.query(`SELECT id,name FROM growth_os.campaigns WHERE workspace_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [workspaceId]),
    db.query(`SELECT id,name FROM growth_os.sprints WHERE workspace_id=$1 AND status='active' LIMIT 1`, [workspaceId]),
    db.query(`
      SELECT f.id,f.due_at,f.priority,f.status,w.name AS person_name
      FROM growth_os.follow_up_tasks f
      JOIN growth_os.community_profiles p ON p.id=f.community_profile_id AND p.workspace_id=f.workspace_id
      LEFT JOIN public.waitlist_signups w ON w.id=p.waitlist_signup_id
      WHERE f.workspace_id=$1 AND f.status='pending'
    `, [workspaceId]),
    db.query(`
      SELECT w.id,w.name FROM public.waitlist_signups w
      LEFT JOIN growth_os.community_profiles p
        ON p.waitlist_signup_id=w.id AND p.workspace_id=$1
      WHERE p.reviewed_at IS NULL
      ORDER BY w.created_at
      LIMIT 20
    `, [workspaceId]),
    db.query(`
      SELECT q.id,w.name AS person_name
      FROM growth_os.mvp_qualifications q
      JOIN growth_os.community_profiles p ON p.id=q.community_profile_id AND p.workspace_id=q.workspace_id
      LEFT JOIN public.waitlist_signups w ON w.id=p.waitlist_signup_id
      WHERE q.workspace_id=$1
        AND q.founder_assessment IN ('strong_potential_tester','confirmed_tester','champion_potential')
        AND NULLIF(trim(p.next_action),'') IS NULL
    `, [workspaceId]),
    db.query(`
      SELECT r.id,w.name AS person_name
      FROM growth_os.referrals r
      JOIN growth_os.community_profiles p ON p.id=r.referrer_profile_id AND p.workspace_id=r.workspace_id
      LEFT JOIN public.waitlist_signups w ON w.id=p.waitlist_signup_id
      WHERE r.workspace_id=$1 AND r.status IN ('recorded','joined')
    `, [workspaceId]),
    db.query(`SELECT id,label,target_date,current_value,target_value FROM growth_os.goals WHERE workspace_id=$1 AND status='active'`, [workspaceId]),
    db.query(`SELECT id,title,recommended_decision,status FROM growth_os.insights WHERE workspace_id=$1 AND status='active' ORDER BY created_at LIMIT 20`, [workspaceId]),
    db.query(`SELECT max(snapshot_date)::text AS last_metric_date FROM growth_os.metric_snapshots WHERE workspace_id=$1`, [workspaceId]),
    historyQuery
  ]);
  const configured = listSocialAdapters()
    .filter(adapter => validateSocialEnvironment(adapter.definition.id).available)
    .map(adapter => adapter.definition.id);
  return deriveMissionCandidates({
    social_connections: social.rows,
    configured_social_providers: configured,
    content: content.rows,
    active_campaign: campaign.rows[0] ?? null,
    active_sprint: sprint.rows[0] ?? null,
    follow_ups: followUps.rows,
    unreviewed_waitlist: unreviewed.rows,
    qualification_actions: qualifications.rows,
    unresolved_referrals: referrals.rows,
    goals: goals.rows,
    insights: insights.rows,
    last_metric_date: metrics.rows[0]?.last_metric_date ?? null
  }, history.rows, now);
};

export const dismissMissionCandidate = async (
  workspaceId: string,
  candidateKey: string,
  candidateType: string,
  reason: string | undefined,
  now = new Date(),
  db: Db = pool
) => {
  const candidates = await getMissionCandidates(workspaceId, now, db);
  const selected = candidates.find(item => item.deduplication_key === candidateKey);
  if (!selected || selected.candidate_type !== candidateType) throw candidateError(
    "This recommendation is no longer current or is already within its cooldown period.",
    "mission_candidate_unavailable",
    409
  );
  const result = await db.query(`
    INSERT INTO growth_os.mission_candidate_dismissals(
      workspace_id,candidate_key,candidate_type,reason,dismissed_at
    ) VALUES($1,$2,$3,$4,$5)
    RETURNING id,candidate_key,candidate_type,reason,dismissed_at
  `, [workspaceId,candidateKey,candidateType,reason?.trim() || null,now.toISOString()]);
  return result.rows[0];
};

export const acceptMissionCandidate = async (
  workspaceId: string,
  candidateKey: string,
  missionDate: string,
  now = new Date(),
  db: Db = pool
) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(missionDate)) {
    throw candidateError("mission_date must be YYYY-MM-DD", "invalid_growth_payload", 400);
  }
  const candidates = await getMissionCandidates(workspaceId, now, db);
  const selected = candidates.find(item => item.deduplication_key === candidateKey);
  if (!selected) throw candidateError(
    "This recommendation is no longer current or is within its cooldown period.",
    "mission_candidate_unavailable",
    409
  );
  try {
    const result = await db.query(`
      INSERT INTO growth_os.daily_missions(
        workspace_id,sprint_id,campaign_id,title,description,reason,expected_outcome,estimated_minutes,
        priority,mission_date,status,candidate_type,candidate_key,source_module,
        related_entity_type,related_entity_id,completion_condition,cooldown_metadata
      ) VALUES(
        $1,
        (SELECT id FROM growth_os.sprints WHERE workspace_id=$1 AND status='active' LIMIT 1),
        (SELECT id FROM growth_os.campaigns WHERE workspace_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1),
        $2,$3,$4,$5,$6,$7,$8,'planned',$9,$10,$11,$12,$13,$14,$15
      )
      RETURNING *
    `, [
      workspaceId, selected.title, selected.description, selected.why_it_matters,
      selected.expected_outcome, selected.estimated_minutes, selected.urgency,
      missionDate, selected.candidate_type, selected.deduplication_key,
      selected.source_module, selected.related_entity_type, selected.related_entity_id,
      selected.completion_condition, selected.cooldown
    ]);
    return result.rows[0];
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505") throw candidateError(
      "An active mission already exists for this recommendation.",
      "duplicate_active_mission_candidate",
      409
    );
    throw cause;
  }
};

export type CompletionEvaluation = {
  satisfied: boolean;
  message: string;
};

export const evaluateMissionCompletion = async (
  workspaceId: string,
  mission: Record<string, unknown>,
  now = new Date(),
  db: Db = pool
): Promise<CompletionEvaluation> => {
  const condition = mission.completion_condition as Record<string, unknown> | null;
  if (!condition?.evaluator) return {
    satisfied: false,
    message: "This existing mission has no automatic outcome check. Confirm a manual close and explain what was completed."
  };
  const id = String(condition.id ?? mission.related_entity_id ?? "");
  let query = "";
  let params: unknown[] = [workspaceId];
  switch (condition.evaluator) {
    case "social_connection_status":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.social_connections WHERE workspace_id=$1 AND provider=$2 AND status=$3) AS satisfied`;
      params = [workspaceId, condition.provider, condition.status];
      break;
    case "waitlist_reviewed":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.community_profiles WHERE workspace_id=$1 AND waitlist_signup_id=$2 AND reviewed_at IS NOT NULL) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "follow_up_completed":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.follow_up_tasks WHERE workspace_id=$1 AND id=$2 AND status='completed') AS satisfied`;
      params = [workspaceId,id];
      break;
    case "content_scheduled":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.content_items WHERE workspace_id=$1 AND id=$2 AND scheduled_at IS NOT NULL) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "campaign_has_prepared_content":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.content_items WHERE workspace_id=$1 AND campaign_id=$2 AND status IN ('script','record','edit','scheduled','published','results','repurpose')) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "insight_reviewed":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.insights WHERE workspace_id=$1 AND id=$2 AND status IN ('actioned','archived')) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "qualification_actioned":
      query = `SELECT EXISTS(
        SELECT 1 FROM growth_os.mvp_qualifications q
        JOIN growth_os.community_profiles p ON p.id=q.community_profile_id AND p.workspace_id=q.workspace_id
        WHERE q.workspace_id=$1 AND q.id=$2 AND NULLIF(trim(p.next_action),'') IS NOT NULL
      ) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "referral_resolved":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.referrals WHERE workspace_id=$1 AND id=$2 AND status IN ('acknowledged','archived')) AS satisfied`;
      params = [workspaceId,id];
      break;
    case "current_metrics_snapshot": {
      const days = Number(condition.within_days ?? 7);
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.metric_snapshots WHERE workspace_id=$1 AND snapshot_date >= $2::date) AS satisfied`;
      params = [workspaceId,new Date(now.getTime() - days * dayMs).toISOString().slice(0,10)];
      break;
    }
    case "recent_content_published": {
      const days = Number(condition.within_days ?? 1);
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.content_items WHERE workspace_id=$1 AND published_at >= $2::timestamptz) AS satisfied`;
      params = [workspaceId,new Date(now.getTime() - days * dayMs).toISOString()];
      break;
    }
    case "content_updated_after_acceptance":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.content_items WHERE workspace_id=$1 AND id=$2 AND updated_at>$3::timestamptz) AS satisfied`;
      params = [workspaceId,id,mission.created_at];
      break;
    case "goal_updated_after_acceptance":
      query = `SELECT EXISTS(SELECT 1 FROM growth_os.goals WHERE workspace_id=$1 AND id=$2 AND updated_at>$3::timestamptz) AS satisfied`;
      params = [workspaceId,id,mission.created_at];
      break;
    case "content_final_review":
      query = `SELECT false AS satisfied`;
      break;
    default:
      return { satisfied: false, message: "This mission type does not yet have an outcome evaluator. Confirm a manual close with a reason." };
  }
  const result = await db.query(query, params);
  const satisfied = result.rows[0]?.satisfied === true;
  return {
    satisfied,
    message: satisfied
      ? "The saved operational outcome has been verified."
      : "The required saved outcome has not been detected yet."
  };
};

export const completeMission = async (
  workspaceId: string,
  missionId: string,
  input: { manual_close?: boolean; manual_close_reason?: string },
  now = new Date(),
  db: Db = pool
) => {
  const missionResult = await db.query(
    `SELECT * FROM growth_os.daily_missions WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,missionId]
  );
  const mission = missionResult.rows[0];
  if (!mission) throw candidateError("Mission not found", "growth_record_not_found", 404);
  if (!["planned","active"].includes(mission.status)) throw candidateError(
    "Only an open mission can be completed.",
    "mission_not_open",
    409
  );
  const evaluation = await evaluateMissionCompletion(workspaceId, mission, now, db);
  if (!evaluation.satisfied && !input.manual_close) throw candidateError(
    evaluation.message,
    "mission_completion_confirmation_required",
    409,
    { completion_condition: mission.completion_condition }
  );
  const reason = input.manual_close_reason?.trim() ?? "";
  if (!evaluation.satisfied && reason.length < 5) throw candidateError(
    "Please provide a brief reason for manually closing this mission.",
    "manual_close_reason_required",
    400
  );
  const result = await db.query(`
    UPDATE growth_os.daily_missions SET
      status='completed',completed_at=$3,
      completion_verification=$4,
      outcome_verified_at=$5,
      manual_close_reason=$6
    WHERE workspace_id=$1 AND id=$2
    RETURNING *
  `, [
    workspaceId,missionId,now.toISOString(),
    evaluation.satisfied ? "outcome_verified" : "manual_closed",
    evaluation.satisfied ? now.toISOString() : null,
    evaluation.satisfied ? null : reason
  ]);
  return { mission: result.rows[0], evaluation };
};
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { listSocialAdapters, validateSocialEnvironment } from "./social/social.registry";

type Db = Pick<PoolClient, "query">;
