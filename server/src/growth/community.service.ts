import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db = Pick<PoolClient, "query">;
type Input = Record<string, unknown>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stages = new Set([
  "new", "reviewed", "engaged", "waitlist", "research_participant", "mvp_interested",
  "potential_tester", "confirmed_tester", "founding_member", "champion", "advocate",
  "inactive", "opted_out"
]);
const error = (message: string, code = "invalid_community_payload", statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
const text = (value: unknown, limit = 4000) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw error("Text fields must be strings");
  return value.trim().slice(0, limit) || null;
};
const timestamp = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw error("Date must be a valid ISO timestamp");
  return value;
};
const boolean = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "boolean") throw error("Boolean fields must be true or false");
  return value;
};
const uuid = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !uuidPattern.test(value)) throw error("Reference must be a UUID");
  return value;
};
const enumValue = (value: unknown, allowed: readonly string[], field: string) => {
  const parsed = text(value, 80);
  if (!parsed || !allowed.includes(parsed)) throw error(`Invalid ${field}`);
  return parsed;
};
const tags = (value: unknown) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw error("tags must be an array of strings");
  return [...new Set(value.map(item => item.trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
};

export const getCommunitySummary = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`
    WITH people AS (
      SELECT w.id,w.source,w.created_at,p.id AS profile_id,p.reviewed_at,
        p.mvp_interest_status,p.tester_status,p.founding_member_status,p.champion_status
      FROM public.waitlist_signups w
      LEFT JOIN growth_os.community_profiles p
        ON p.waitlist_signup_id=w.id AND p.workspace_id=$1
    ),
    sources AS (
      SELECT jsonb_object_agg(source,total) AS distribution
      FROM (
        SELECT COALESCE(NULLIF(trim(source),''),'Unknown') source,COUNT(*)::int total
        FROM public.waitlist_signups GROUP BY 1
      ) grouped_sources
    )
    SELECT
      COUNT(people.id)::int AS total_waitlist_signups,
      COUNT(people.id) FILTER (WHERE people.created_at >= date_trunc('week', now()))::int AS signups_this_week,
      COUNT(people.id) FILTER (WHERE people.created_at >= date_trunc('month', now()))::int AS signups_this_month,
      COUNT(people.profile_id) FILTER (WHERE people.reviewed_at IS NOT NULL)::int AS reviewed,
      COUNT(people.id) FILTER (WHERE people.reviewed_at IS NULL)::int AS unreviewed,
      COALESCE((SELECT distribution FROM sources), '{}'::jsonb) AS source_distribution,
      (SELECT COUNT(*)::int FROM growth_os.interactions i
       WHERE i.workspace_id=$1 AND i.archived_at IS NULL
         AND i.occurred_at >= date_trunc('week', now())) AS meaningful_conversations_this_week,
      COUNT(people.profile_id) FILTER (WHERE people.mvp_interest_status='interested')::int AS mvp_interested,
      COUNT(people.profile_id) FILTER (WHERE people.tester_status='potential')::int AS potential_testers,
      COUNT(people.profile_id) FILTER (WHERE people.tester_status='confirmed')::int AS confirmed_testers,
      COUNT(people.profile_id) FILTER (WHERE people.founding_member_status='confirmed')::int AS founding_members,
      COUNT(people.profile_id) FILTER (WHERE people.champion_status IN ('active','advocate'))::int AS champions,
      (SELECT COUNT(*)::int FROM growth_os.follow_up_tasks f
       WHERE f.workspace_id=$1 AND f.status='pending' AND f.due_at < now()) AS overdue_follow_ups,
      (SELECT COUNT(*)::int FROM growth_os.referrals r
       WHERE r.workspace_id=$1 AND r.status <> 'archived') AS referrals
    FROM people
  `, [workspaceId]);

  if (!result.rows.length) return {
    total_waitlist_signups: 0, signups_this_week: 0, signups_this_month: 0,
    reviewed: 0, unreviewed: 0, source_distribution: {},
    meaningful_conversations_this_week: 0, mvp_interested: 0, potential_testers: 0,
    confirmed_testers: 0, founding_members: 0, champions: 0, overdue_follow_ups: 0, referrals: 0
  };
  return result.rows[0];
};

const peopleSelect = `
  w.id AS waitlist_id, p.id AS community_profile_id, w.name, w.email, w.phone,
  w.source, w.created_at AS joined_at, (p.reviewed_at IS NOT NULL) AS reviewed,
  COALESCE(p.relationship_stage,'new') AS relationship_stage,
  COALESCE(p.mvp_interest_status,'not_recorded') AS mvp_interest_status,
  COALESCE(p.tester_status,'not_assessed') AS tester_status,
  COALESCE(p.founding_member_status,'not_assessed') AS founding_member_status,
  COALESCE(p.champion_status,'not_assessed') AS champion_status,
  p.last_interaction_at, p.next_action, p.next_action_due_at,
  COALESCE(p.tags,'{}') AS tags, COALESCE(p.status,'active') AS status
`;

export const listCommunityPeople = async (workspaceId: string, query: Input, db: Db = pool) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.page_size) || 20)));
  const values: unknown[] = [workspaceId];
  const where = ["1=1"];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  if (text(query.search, 120)) add("(w.name ILIKE '%'||?||'%' OR w.email ILIKE '%'||?||'%')".replace(/\?/g, () => `$${values.length + 1}`), text(query.search, 120));
  if (text(query.source, 100)) add("w.source=?", text(query.source, 100));
  if (query.reviewed === "true") where.push("p.reviewed_at IS NOT NULL");
  if (query.reviewed === "false") where.push("p.reviewed_at IS NULL");
  for (const field of ["relationship_stage","mvp_interest_status","tester_status","champion_status"] as const) {
    if (text(query[field], 80)) add(`COALESCE(p.${field},'${field === "relationship_stage" ? "new" : field === "mvp_interest_status" ? "not_recorded" : "not_assessed"}')=?`, text(query[field], 80));
  }
  if (text(query.tag, 60)) add("?=ANY(COALESCE(p.tags,'{}'))", text(query.tag, 60));
  if (query.overdue === "true") where.push("p.next_action_due_at < now() AND COALESCE(p.status,'active')='active'");
  if (timestamp(query.joined_from)) add("w.created_at>=?", timestamp(query.joined_from));
  if (timestamp(query.joined_to)) add("w.created_at<=?", timestamp(query.joined_to));
  const order = query.order === "oldest" ? "w.created_at ASC" :
    query.order === "next_action_due" ? "p.next_action_due_at ASC NULLS LAST, w.created_at DESC" :
    "w.created_at DESC";
  values.push(pageSize, (page - 1) * pageSize);
  const result = await db.query(`
    SELECT ${peopleSelect}, COUNT(*) OVER()::int AS total
    FROM public.waitlist_signups w
    LEFT JOIN growth_os.community_profiles p
      ON p.waitlist_signup_id=w.id AND p.workspace_id=$1
    WHERE ${where.join(" AND ")}
    ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  return { people: result.rows.map(({ total: _total, ...row }) => row), page, page_size: pageSize, total: Number(result.rows[0]?.total ?? 0) };
};

export const ensureCommunityProfile = async (workspaceId: string, waitlistId: string, db: Db = pool) => {
  uuid(waitlistId);
  const result = await db.query(`
    INSERT INTO growth_os.community_profiles(workspace_id,waitlist_signup_id)
    SELECT $1,w.id FROM public.waitlist_signups w WHERE w.id=$2
    ON CONFLICT(workspace_id,waitlist_signup_id) DO UPDATE SET waitlist_signup_id=EXCLUDED.waitlist_signup_id
    RETURNING *
  `, [workspaceId, waitlistId]);
  if (!result.rows[0]) throw error("Waitlist member not found", "community_person_not_found", 404);
  return result.rows[0];
};

export const getCommunityPerson = async (workspaceId: string, waitlistId: string, db: Db = pool) => {
  uuid(waitlistId);
  const person = await db.query(`
    SELECT ${peopleSelect}, p.reviewed_at, p.founder_notes, p.research_interest,
      (p.participant_id IS NOT NULL) AS research_participant
    FROM public.waitlist_signups w
    LEFT JOIN growth_os.community_profiles p ON p.waitlist_signup_id=w.id AND p.workspace_id=$1
    WHERE w.id=$2
  `, [workspaceId, waitlistId]);
  if (!person.rows[0]) throw error("Waitlist member not found", "community_person_not_found", 404);
  const profileId = person.rows[0].community_profile_id;
  const empty = { rows: [] as unknown[] };
  const [history, interactions, followUps, referrals, qualification] = profileId ? await Promise.all([
    db.query(`SELECT id,previous_stage,new_stage,reason,changed_at FROM growth_os.relationship_stage_history WHERE workspace_id=$1 AND community_profile_id=$2 ORDER BY changed_at DESC`, [workspaceId, profileId]),
    db.query(`SELECT * FROM growth_os.interactions WHERE workspace_id=$1 AND community_profile_id=$2 AND archived_at IS NULL ORDER BY occurred_at DESC`, [workspaceId, profileId]),
    db.query(`SELECT * FROM growth_os.follow_up_tasks WHERE workspace_id=$1 AND community_profile_id=$2 ORDER BY due_at DESC`, [workspaceId, profileId]),
    db.query(`SELECT * FROM growth_os.referrals WHERE workspace_id=$1 AND referrer_profile_id=$2 AND status<>'archived' ORDER BY referred_at DESC`, [workspaceId, profileId]),
    db.query(`SELECT * FROM growth_os.mvp_qualifications WHERE workspace_id=$1 AND community_profile_id=$2`, [workspaceId, profileId])
  ]) : [empty, empty, empty, empty, empty];
  return { ...person.rows[0], stage_history: history.rows, interactions: interactions.rows, follow_ups: followUps.rows, referrals: referrals.rows, qualification: qualification.rows[0] ?? null };
};

export const updateCommunityProfile = async (workspaceId: string, waitlistId: string, input: Input, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  const allowed: Record<string, (value: unknown) => unknown> = {
    founder_notes: value => text(value),
    next_action: value => text(value, 500),
    next_action_due_at: timestamp,
    tags,
    research_interest: boolean,
    participant_id: uuid,
    mvp_interest_status: value => enumValue(value, ["not_recorded","interested","not_interested","follow_up_required"], "MVP interest status"),
    tester_status: value => enumValue(value, ["not_assessed","potential","invited","confirmed","not_suitable"], "tester status"),
    founding_member_status: value => enumValue(value, ["not_assessed","potential","confirmed","inactive"], "founding member status"),
    champion_status: value => enumValue(value, ["not_assessed","potential","active","advocate","inactive"], "champion status"),
    status: value => enumValue(value, ["active","archived"], "profile status")
  };
  const unknown = Object.keys(input).filter(key => !allowed[key]);
  if (unknown.length) throw error(`Unknown fields: ${unknown.join(", ")}`);
  const parsed = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, allowed[key](value)]));
  if (parsed.status === "archived") parsed.archived_at = new Date().toISOString();
  const keys = Object.keys(parsed);
  if (!keys.length) throw error("No profile fields supplied");
  const values = keys.map(key => parsed[key]);
  values.push(workspaceId, profile.id);
  const result = await db.query(`UPDATE growth_os.community_profiles SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")} WHERE workspace_id=$${values.length - 1} AND id=$${values.length} RETURNING *`, values);
  return result.rows[0];
};

export const markCommunityPersonReviewed = async (workspaceId: string, waitlistId: string, userId: string, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  const result = await db.query(`UPDATE growth_os.community_profiles SET reviewed_at=COALESCE(reviewed_at,now()), relationship_stage=CASE WHEN relationship_stage='new' THEN 'reviewed' ELSE relationship_stage END WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, profile.id]);
  if (profile.relationship_stage === "new") await db.query(`INSERT INTO growth_os.relationship_stage_history(workspace_id,community_profile_id,previous_stage,new_stage,reason,changed_by) VALUES($1,$2,'new','reviewed','Founder reviewed the waitlist member',$3)`, [workspaceId, profile.id, userId]);
  return result.rows[0];
};

export const changeCommunityStage = async (workspaceId: string, waitlistId: string, userId: string, input: Input, db: Db = pool) => {
  const next = text(input.stage, 80);
  if (!next || !stages.has(next)) throw error("Invalid relationship stage");
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  if (profile.relationship_stage === next) return profile;
  await db.query(`INSERT INTO growth_os.relationship_stage_history(workspace_id,community_profile_id,previous_stage,new_stage,reason,changed_by) VALUES($1,$2,$3,$4,$5,$6)`, [workspaceId, profile.id, profile.relationship_stage, next, text(input.reason, 500), userId]);
  const result = await db.query(`UPDATE growth_os.community_profiles SET relationship_stage=$3, reviewed_at=COALESCE(reviewed_at,now()) WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, profile.id, next]);
  return result.rows[0];
};

export const createInteraction = async (workspaceId: string, waitlistId: string, userId: string, input: Input, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  if (profile.relationship_stage === "opted_out" && input.follow_up_at) throw error("Communication follow-ups are blocked for opted-out people", "community_contact_blocked", 409);
  const type = enumValue(input.interaction_type, ["comment","direct_message","email","interview","event","referral","partner_introduction","research_call","tester_call","other"], "interaction type");
  const channel = enumValue(input.channel, ["tiktok","instagram","linkedin","email","whatsapp","website","in_person","video_call","phone","other"], "channel");
  const summary = text(input.summary);
  const occurredAt = timestamp(input.occurred_at);
  if (!summary || !occurredAt) throw error("Summary and occurred date are required");
  const approvedQuote = boolean(input.approved_quote) ?? false;
  const quotePermission = boolean(input.quote_use_permission) ?? false;
  if (approvedQuote && !quotePermission) throw error("External quote approval requires explicit quote-use permission");
  const fields = ["workspace_id","community_profile_id","interaction_type","channel","occurred_at","summary","exact_customer_language","problem_or_need","objection","product_interest","approved_quote","quote_use_permission","linked_content_item_id","linked_campaign_id","linked_customer_question_id","next_action","follow_up_at","created_by"];
  const values = [workspaceId,profile.id,type,channel,occurredAt,summary,text(input.exact_customer_language),text(input.problem_or_need),text(input.objection),text(input.product_interest),approvedQuote,quotePermission,uuid(input.linked_content_item_id),uuid(input.linked_campaign_id),uuid(input.linked_customer_question_id),text(input.next_action),timestamp(input.follow_up_at),userId];
  const result = await db.query(`INSERT INTO growth_os.interactions(${fields.join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, values);
  await db.query(`UPDATE growth_os.community_profiles SET last_interaction_at=$3,next_action=COALESCE($4,next_action),next_action_due_at=COALESCE($5,next_action_due_at) WHERE workspace_id=$1 AND id=$2`, [workspaceId, profile.id, occurredAt, text(input.next_action), timestamp(input.follow_up_at)]);
  return result.rows[0];
};

export const listInteractions = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`
    SELECT i.*,w.id AS waitlist_id,w.name AS person_name
    FROM growth_os.interactions i
    JOIN growth_os.community_profiles p ON p.id=i.community_profile_id AND p.workspace_id=i.workspace_id
    LEFT JOIN public.waitlist_signups w ON w.id=p.waitlist_signup_id
    WHERE i.workspace_id=$1 AND i.archived_at IS NULL
    ORDER BY i.occurred_at DESC
  `, [workspaceId]);
  return result.rows;
};

export const listFollowUps = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`
    SELECT f.*,w.id AS waitlist_id,w.name AS person_name
    FROM growth_os.follow_up_tasks f
    JOIN growth_os.community_profiles p ON p.id=f.community_profile_id AND p.workspace_id=f.workspace_id
    LEFT JOIN public.waitlist_signups w ON w.id=p.waitlist_signup_id
    WHERE f.workspace_id=$1 ORDER BY (f.status='pending' AND f.due_at<now()) DESC,f.due_at ASC
  `, [workspaceId]);
  return result.rows;
};

export const createFollowUp = async (workspaceId: string, waitlistId: string, input: Input, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  if (profile.relationship_stage === "opted_out") throw error("Communication actions are blocked for opted-out people", "community_contact_blocked", 409);
  const type = enumValue(input.follow_up_type, ["welcome","reply","interview_invitation","interview_follow_up","mvp_invitation","feedback_request","referral_thank_you","quote_permission","re_engagement","partner_follow_up","media_follow_up","other"], "follow-up type");
  const title = text(input.title, 300);
  const dueAt = timestamp(input.due_at);
  if (!title || !dueAt) throw error("Title and due date are required");
  const result = await db.query(`INSERT INTO growth_os.follow_up_tasks(workspace_id,community_profile_id,interaction_id,follow_up_type,title,reason,priority,due_at,notes,linked_campaign_id,linked_content_item_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [workspaceId,profile.id,uuid(input.interaction_id),type,title,text(input.reason),enumValue(input.priority ?? "medium",["low","medium","high","urgent"],"priority"),dueAt,text(input.notes),uuid(input.linked_campaign_id),uuid(input.linked_content_item_id)]);
  await db.query(`UPDATE growth_os.community_profiles SET next_action=$3,next_action_due_at=$4 WHERE workspace_id=$1 AND id=$2`, [workspaceId,profile.id,title,dueAt]);
  return result.rows[0];
};

export const updateFollowUp = async (workspaceId: string, id: string, input: Input, db: Db = pool) => {
  uuid(id);
  const allowed: Record<string, (value: unknown) => unknown> = {
    title: value => text(value, 300), reason: value => text(value), notes: value => text(value),
    due_at: timestamp,
    priority: value => enumValue(value, ["low","medium","high","urgent"], "priority"),
    status: value => enumValue(value, ["pending","completed","skipped","cancelled"], "status")
  };
  const unknown = Object.keys(input).filter(key => !allowed[key]);
  if (unknown.length) throw error(`Unknown fields: ${unknown.join(", ")}`);
  const parsed: Input = Object.fromEntries(Object.entries(input).map(([key,value]) => [key,allowed[key](value)]));
  if (parsed.status === "completed") parsed.completed_at = new Date().toISOString();
  if (parsed.status === "skipped") parsed.skipped_at = new Date().toISOString();
  const keys = Object.keys(parsed);
  const values = keys.map(key => parsed[key]);
  values.push(workspaceId,id);
  const result = await db.query(`UPDATE growth_os.follow_up_tasks SET ${keys.map((key,index) => `${key}=$${index + 1}`).join(",")} WHERE workspace_id=$${values.length - 1} AND id=$${values.length} RETURNING *`, values);
  if (!result.rows[0]) throw error("Follow-up not found", "community_follow_up_not_found", 404);
  return result.rows[0];
};

export const saveQualification = async (workspaceId: string, waitlistId: string, input: Input, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  const fields = ["primary_problem","frequency","daily_life_effect","current_solution","money_already_spent","willing_to_wear_prototype","willing_to_give_regular_feedback","available_for_interview","preferred_contact_method","participation_needs","testing_concerns","consent_to_future_testing_contact","founder_assessment","assessment_notes"] as const;
  const parsed: Input = {};
  for (const field of fields) if (field in input) parsed[field] = field.startsWith("willing_") || field === "available_for_interview" || field === "consent_to_future_testing_contact" ? boolean(input[field]) : field === "founder_assessment" ? enumValue(input[field], ["not_assessed","nurture","invite_to_interview","strong_potential_tester","confirmed_tester","champion_potential","not_suitable_currently"], "founder assessment") : text(input[field]);
  parsed.assessed_at = new Date().toISOString();
  const keys = Object.keys(parsed);
  const values = [workspaceId,profile.id,...keys.map(key => parsed[key])];
  const result = await db.query(`INSERT INTO growth_os.mvp_qualifications(workspace_id,community_profile_id,${keys.join(",")}) VALUES(${values.map((_,index) => `$${index + 1}`).join(",")}) ON CONFLICT(workspace_id,community_profile_id) DO UPDATE SET ${keys.map((key,index) => `${key}=$${index + 3}`).join(",")} RETURNING *`, values);
  return result.rows[0];
};

export const deterministicDraft = (kind: string, firstName: string, stage: string) => {
  const name = firstName.trim().split(/\s+/)[0] || "there";
  const drafts: Record<string,string> = {
    welcome: `Hi ${name}, thank you for joining the KLPS waitlist. I’m Emma, the founder. I’d love to learn what brought you to KLPS and what would be most useful to you.`,
    interview_invitation: `Hi ${name}, thank you for your interest in KLPS. Would you be open to a short research conversation about your experience? Participation is entirely optional.`,
    mvp_invitation: `Hi ${name}, you previously expressed interest in KLPS. We are preparing future prototype research and I’d like to ask whether you would be open to hearing more. This is not a medical product invitation or confirmation of eligibility.`,
    quote_permission: `Hi ${name}, may KLPS use the words you shared as a quote? Please confirm whether you consent to external use and whether you prefer it to be anonymous.`
  };
  if (stage === "opted_out") throw error("Communication drafts are blocked for opted-out people", "community_contact_blocked", 409);
  return drafts[kind] ?? `Hi ${name}, I’m following up from KLPS regarding our previous conversation.`;
};

export const createReferral = async (workspaceId: string, waitlistId: string, input: Input, db: Db = pool) => {
  const profile = await ensureCommunityProfile(workspaceId, waitlistId, db);
  const result = await db.query(`
    INSERT INTO growth_os.referrals(
      workspace_id,referrer_profile_id,referred_waitlist_signup_id,referral_source,
      campaign_id,status,referred_at,notes
    ) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8) RETURNING *
  `, [workspaceId,profile.id,uuid(input.referred_waitlist_signup_id),text(input.referral_source,200),uuid(input.campaign_id),enumValue(input.status ?? "recorded",["recorded","joined","acknowledged","archived"],"referral status"),timestamp(input.referred_at),text(input.notes)]);
  return result.rows[0];
};

export const getCommunityVoice = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`
    SELECT i.id,i.occurred_at,i.exact_customer_language,i.problem_or_need,i.objection,
      i.quote_use_permission,i.approved_quote,i.linked_customer_question_id,i.linked_content_item_id,
      CASE WHEN i.quote_use_permission THEN 'approved_for_external_use' ELSE 'internal_only' END AS use_status
    FROM growth_os.interactions i
    WHERE i.workspace_id=$1 AND i.archived_at IS NULL
      AND i.exact_customer_language IS NOT NULL
    ORDER BY i.occurred_at DESC
  `, [workspaceId]);
  return result.rows;
};

const buildTrackedUrl = (destination: string, source: string, medium: string, campaign: string | null, code: string) => {
  let parsed: URL;
  try { parsed = new URL(destination); } catch { throw error("destination_url must be a valid URL"); }
  parsed.searchParams.set("utm_source", source);
  parsed.searchParams.set("utm_medium", medium);
  if (campaign) parsed.searchParams.set("utm_campaign", campaign);
  parsed.searchParams.set("klps_ref", code);
  return parsed.toString();
};

export const listTrackedLinks = async (workspaceId: string, db: Db = pool) => {
  const result = await db.query(`SELECT * FROM growth_os.tracked_links WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId]);
  return result.rows;
};

export const createTrackedLink = async (workspaceId: string, input: Input, db: Db = pool) => {
  const labelValue = text(input.label, 200);
  const destination = text(input.destination_url, 2000);
  const source = text(input.source, 120);
  const medium = text(input.medium, 120);
  const campaign = text(input.campaign, 200);
  if (!labelValue || !destination || !source || !medium) throw error("Label, destination, source and medium are required");
  const codeResult = await db.query(`SELECT encode(gen_random_bytes(9),'hex') AS code`);
  const code = codeResult.rows[0].code;
  const generated = buildTrackedUrl(destination, source, medium, campaign, code);
  const result = await db.query(`
    INSERT INTO growth_os.tracked_links(
      workspace_id,public_code,label,destination_url,source,medium,campaign,
      content_item_id,campaign_id,referral_code,generated_url
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [workspaceId,code,labelValue,destination,source,medium,campaign,uuid(input.content_item_id),uuid(input.campaign_id),text(input.referral_code,120),generated]);
  return result.rows[0];
};

export const getTractionSummary = async (workspaceId: string, db: Db = pool) => {
  const summary = await getCommunitySummary(workspaceId, db);
  const content = await db.query(`SELECT COUNT(*)::int AS published FROM growth_os.content_items WHERE workspace_id=$1 AND status IN ('published','results','repurpose')`, [workspaceId]);
  return {
    evidence: {
      content_published: content.rows[0]?.published ?? 0,
      waitlist_growth_this_week: summary.signups_this_week,
      reviewed_members: summary.reviewed,
      meaningful_conversations: summary.meaningful_conversations_this_week,
      mvp_interest_expressions: summary.mvp_interested,
      potential_testers: summary.potential_testers,
      confirmed_testers: summary.confirmed_testers,
      founding_members: summary.founding_members,
      referrals: summary.referrals
    },
    caveat: "Counts reflect stored first-party records and founder-confirmed relationships. Timing does not establish causation.",
    formats: ["founder_weekly_update","investor_update","grant_evidence","partner_update","community_update"]
  };
};
