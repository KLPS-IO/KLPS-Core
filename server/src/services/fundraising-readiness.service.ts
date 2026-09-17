import { subdivisionReview } from './subdivision-review';
import { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { FOUNDER_DECISION, READINESS_REQUIREMENTS, REQUEST_SOURCE } from './fundraising-readiness.template';

type Db = Pick<PoolClient, 'query'>;
type Input = Record<string, unknown>;
export const CLASSIFICATIONS = ['AVAILABLE + VERIFIED','AVAILABLE + REVIEW REQUIRED','MISSING','FOUNDER INPUT REQUIRED','EXTERNAL ACTION REQUIRED','CONFLICT — REVIEW REQUIRED','NOT APPLICABLE'] as const;
export const ACTIVITY_KINDS = ['founder_decision','provider_decision','correspondence','milestone','document_received','document_generated','supplied','approval','cost_reference','payment_reference'] as const;
export const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'readiness_validation' });
export function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) throw fail(`${field} is required (maximum 10,000 characters)`);
  return value.trim();
}
export function uuid(value: unknown): string {
  const id = required(value, 'Record ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw fail('Invalid record ID');
  return id;
}
function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > 0.001) throw fail('Amounts must be positive numbers with at most two decimal places');
  return value;
}
export function validateScenario(input: Input) {
  if (Object.keys(input).some(key => !['name','proposed_investment','pre_money_valuation','baseline_id','notes'].includes(key))) throw fail('Unsupported scenario field');
  return { name: required(input.name, 'Scenario name'), proposed_investment: amount(input.proposed_investment), pre_money_valuation: amount(input.pre_money_valuation), baseline_id: input.baseline_id ? uuid(input.baseline_id) : null, notes: typeof input.notes === 'string' ? input.notes.slice(0,10000) : '' };
}

export type Holding = { shareholder: string; shareholder_type: string; share_class: string; shares: number; nominal_value: number; amount_paid: number; amount_unpaid: number; acquisition_date: string; voting_rights: string; notes?: string };
export function calculateOwnership(holdings: Holding[]) {
  if (!Array.isArray(holdings) || !holdings.length || holdings.some(h => !h.shareholder || !h.share_class || !Number.isSafeInteger(h.shares) || h.shares <= 0 || !Number.isFinite(h.nominal_value) || h.nominal_value < 0 || !Number.isFinite(h.amount_paid) || h.amount_paid < 0 || !Number.isFinite(h.amount_unpaid) || h.amount_unpaid < 0)) throw fail('Ownership counts and monetary fields require review');
  const shares = holdings.reduce((sum,h) => sum + h.shares, 0);
  if (!Number.isSafeInteger(shares)) throw fail('Share total exceeds supported precision');
  return { shares, nominal_capital: holdings.reduce((sum,h) => sum + h.shares * h.nominal_value,0), holdings: holdings.map(h => ({ ...h, ownership: h.shares / shares })), total_ownership: holdings.reduce((sum,h) => sum + h.shares / shares,0) };
}
export function assessSnapshot(snapshot: Input): Input & {usable:boolean;review_required?:string;calculated?:ReturnType<typeof calculateOwnership>} {
  const current = snapshot.verification_status === 'VERIFIED' && snapshot.evidence_status === 'Verified' && snapshot.evidence_document_status === 'Active' && snapshot.evidence_version === snapshot.current_evidence_version;
  const effective = String(snapshot.effective_date).slice(0,10);
  if (!current || !/^\d{4}-\d{2}-\d{2}$/.test(effective) || effective > new Date().toISOString().slice(0,10)) return {...snapshot, usable:false, review_required:'Evidence, approval, date or evidence version requires review.'};
  try { return {...snapshot, usable:true, calculated:calculateOwnership(snapshot.holdings as Holding[])}; }
  catch { return {...snapshot, usable:false, review_required:'Holding counts or monetary fields require review.'}; }
}
export function calculateScenario(investment: number | null, preMoney: number | null, baseline?: Holding[]) {
  if (investment == null || preMoney == null) return { status: 'SCENARIO', available: false, missing: 'Investment and pre-money valuation are required for calculations.' };
  amount(investment); amount(preMoney);
  const postMoney = investment + preMoney;
  const ownership = baseline ? calculateOwnership(baseline) : null;
  const price = ownership ? preMoney / ownership.shares : null;
  const shares = price ? investment / price : null;
  return { status: 'SCENARIO', available: true, post_money: postMoney, investor_ownership: investment / postMoney,
    existing_holders_retained_fraction: preMoney / postMoney, price_per_share: price, theoretical_new_shares: shares,
    theoretical_post_round_shares: ownership && shares !== null ? ownership.shares + shares : null,
    holdings: ownership?.holdings.map(h => ({ shareholder: h.shareholder, before: h.ownership, after: h.ownership * preMoney / postMoney })) ?? null,
    requires_share_rounding_review: shares !== null && !Number.isSafeInteger(shares),
    basis: 'Simple priced equity scenario; no options, convertibles, preferences or share split assumed. Voting and fully diluted ownership are not inferred.' };
}

async function company(db: Db) {
  const result = await db.query("SELECT id, legal_name, company_number FROM finance_os.company WHERE company_number = '16436591'");
  if (result.rows.length !== 1) throw fail('Canonical KLPS company must exist before readiness setup', 409);
  return result.rows[0];
}
async function engagement(id: string, db: Db, lock = false) {
  const c = await company(db);
  const result = await db.query(`SELECT *, start_date::text AS start_date FROM finance_os.fundraising_engagements WHERE id=$1 AND company_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [uuid(id),c.id]);
  if (!result.rows[0]) throw fail('Engagement not found',404);
  return result.rows[0];
}
async function evidence(id: unknown, db: Db, verified = false) {
  if (!id) { if (verified) throw fail('Verified canonical evidence is required'); return null; }
  const result = await db.query('SELECT id, version, verification_status, document_status FROM finance_os.evidence WHERE id=$1 FOR SHARE',[uuid(id)]);
  const row = result.rows[0];
  if (!row || (verified && (row.verification_status !== 'Verified' || row.document_status !== 'Active'))) throw fail('Active verified canonical evidence is required');
  return row;
}
async function activity(id: string, kind: string, description: string, userId: string, db: Db, source: string, payload: Input = {}, evidenceId: string | null = null, occurredOn: string | null = null) {
  return (await db.query('INSERT INTO finance_os.fundraising_activity (engagement_id,kind,description,recorded_by,source,payload,evidence_id,occurred_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,kind,description,userId,source,JSON.stringify(payload),evidenceId,occurredOn])).rows[0];
}

export async function initialiseReadiness(userId: string, db: Db) {
  const c = await company(db);
  const result = await db.query(`INSERT INTO finance_os.fundraising_engagements (company_id,provider,purpose,budget_ex_vat,price_basis,updated_by)
    VALUES ($1,'FounderCatalyst','First external fundraising preparation / SEIS readiness',995,'Founder-confirmed KLPS-specific agreed cost: £995 + VAT. Provider document pending linkage; no invoice or payable inferred.',$2)
    ON CONFLICT (company_id,provider) DO NOTHING RETURNING *`,[c.id,userId]);
  if (!result.rows[0]) return (await db.query("SELECT *, start_date::text AS start_date FROM finance_os.fundraising_engagements WHERE company_id=$1 AND provider='FounderCatalyst'",[c.id])).rows[0];
  const item = result.rows[0];
  for (const [code,title,location,document,owner,dependency,classification,nextAction] of READINESS_REQUIREMENTS) {
    await db.query('INSERT INTO finance_os.fundraising_requirements (engagement_id,code,title,source,canonical_location,required_document,owner,dependency,classification,next_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[item.id,code,title,code.startsWith('FC') ? REQUEST_SOURCE : 'Founder-approved audit 2026-09-15',location,document,owner,dependency,classification,nextAction]);
  }
  await activity(item.id,'founder_decision',FOUNDER_DECISION,userId,db,'Founder instruction supplied 2026-09-15',{ verification: 'FOUNDER CONFIRMED', provider_document: 'PENDING EVIDENCE' });
  await activity(item.id,'audit','Original reference workbook retained by founder; external examples must never enter KLPS actual ownership.',userId,db,REQUEST_SOURCE,{filename:'CapTable-worked-example (1).xlsx',sha256:'8abcb414b1219e83f3c6140fd8b12e3d7d85a1bd351b33c7a9f571d7bfff98a5',storage_status:'PENDING SECURE REGISTRATION'});
  // Alternatives are not seeded as transactions, investors or selected scenarios.
  return item;
}

export async function getReadiness(db: Db = pool) {
  const c = await company(db);
  const rows = await db.query("SELECT *, start_date::text AS start_date FROM finance_os.fundraising_engagements WHERE company_id=$1 AND provider='FounderCatalyst'",[c.id]);
  const item = rows.rows[0] ?? null;
  if (!item) return { company:c, engagement:null, requirements:[], activity:[], scenarios:[], ownership:[], classifications: CLASSIFICATIONS };
  const requirements = await db.query('SELECT r.*, e.title AS evidence_title, e.version AS evidence_version, e.verification_status AS evidence_status, e.document_status AS evidence_document_status FROM finance_os.fundraising_requirements r LEFT JOIN finance_os.evidence e ON e.id=r.evidence_id WHERE r.engagement_id=$1 ORDER BY code',[item.id]);
  const events = await db.query('SELECT *, occurred_on::text AS occurred_on FROM finance_os.fundraising_activity WHERE engagement_id=$1 ORDER BY recorded_at DESC,id DESC',[item.id]);
  const scenarios = await db.query('SELECT * FROM finance_os.fundraising_scenarios WHERE engagement_id=$1 ORDER BY created_at',[item.id]);
  const snapshots = await db.query('SELECT s.*, s.effective_date::text AS effective_date, e.verification_status AS evidence_status, e.version AS current_evidence_version, e.document_status AS evidence_document_status FROM finance_os.ownership_snapshots s JOIN finance_os.evidence e ON e.id=s.evidence_id WHERE s.company_id=$1 ORDER BY s.effective_date DESC,s.recorded_at DESC',[c.id]);
  const ownership = snapshots.rows.map(s => assessSnapshot(s));
  const scenarioResults = scenarios.rows.map(s => {
    const baseline = ownership.find(o => o.id === s.baseline_id && o.usable);
    return {...s, baseline_review_required:!!s.baseline_id && !baseline, calculation:calculateScenario(s.proposed_investment === null ? null : Number(s.proposed_investment),s.pre_money_valuation === null ? null : Number(s.pre_money_valuation),baseline?.holdings as Holding[] | undefined)};
  });
  return { company:c, engagement:item, requirements:requirements.rows, activity:events.rows, scenarios:scenarioResults, ownership, subdivision_review:subdivisionReview(events.rows), classifications:CLASSIFICATIONS };
}

export async function updateRequirement(id: string, input: Input, userId: string, db: Db) {
  const current = (await db.query('SELECT * FROM finance_os.fundraising_requirements WHERE id=$1 FOR UPDATE',[uuid(id)])).rows[0];
  if (!current) throw fail('Requirement not found',404);
  await engagement(current.engagement_id,db);
  if (input.version !== current.version) throw fail('Requirement changed; reload before saving',409);
  if (!CLASSIFICATIONS.includes(input.classification as typeof CLASSIFICATIONS[number])) throw fail('Invalid classification');
  const verified = input.classification === 'AVAILABLE + VERIFIED';
  if (verified && input.review_confirmed !== true) throw fail('Explicit evidence review confirmation is required');
  const e = await evidence(input.evidence_id,db,verified);
  const notes = required(input.notes,'Review notes / reason');
  const next = required(input.next_action,'Next action');
  const owner = required(input.owner,'Responsible party');
  const updated = (await db.query('UPDATE finance_os.fundraising_requirements SET classification=$1,evidence_id=$2,notes=$3,next_action=$4,owner=$5,version=version+1,updated_at=now(),updated_by=$6,reviewed_evidence_version=$8 WHERE id=$7 RETURNING *',[input.classification,e?.id ?? null,notes,next,owner,userId,id,e?.version ?? null])).rows[0];
  await activity(current.engagement_id,'audit',`Reviewed ${current.code}`,userId,db,'Founder/admin review',{before:current,after:updated,evidence_version:e?.version ?? null},e?.id ?? null);
  return updated;
}

export async function addActivity(id: string, input: Input, userId: string, db: Db) {
  await engagement(id,db);
  const kind = required(input.kind,'Activity kind');
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) throw fail('Unsupported activity');
  const requiresEvidence = ['provider_decision','document_received','document_generated','supplied','approval','cost_reference','payment_reference'].includes(kind);
  if (requiresEvidence && !input.evidence_id) throw fail('Canonical evidence is required for this activity');
  const e = await evidence(input.evidence_id,db,['supplied','approval','payment_reference'].includes(kind));
  const occurred = input.occurred_on ? required(input.occurred_on,'Event date') : null;
  if (occurred && (!/^\d{4}-\d{2}-\d{2}$/.test(occurred) || !Number.isFinite(Date.parse(occurred)) || new Date(occurred).toISOString().slice(0,10) !== occurred)) throw fail('Invalid event date');
  if (requiresEvidence && !occurred) throw fail('Event date is required');
  return activity(id,kind,required(input.description,'Description'),userId,db,required(input.source,'Source'),{evidence_version:e?.version ?? null, effect:'Record only; no external action or financial posting'},e?.id ?? null,occurred);
}

export async function updateEngagement(id: string, input: Input, userId: string, db: Db) {
  const current = await engagement(id,db,true);
  if (input.version !== current.version) throw fail('Engagement changed; reload before saving',409);
  const status = required(input.status,'Status');
  if (!['Preparing','In progress','Awaiting founder','Awaiting provider','Complete','Paused'].includes(status)) throw fail('Invalid process status');
  const reason = required(input.reason,'Change reason');
  const e = await evidence(input.evidence_id,db,status==='Complete');
  const service = input.service_purchased === undefined ? current.service_purchased : input.service_purchased ? required(input.service_purchased,'Service purchased') : null;
  const previousStartDate = current.start_date instanceof Date ? current.start_date.toISOString().slice(0,10) : current.start_date;
  const startDate = input.start_date === undefined ? previousStartDate : input.start_date || null;
  if (startDate && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(Date.parse(startDate)) || new Date(startDate).toISOString().slice(0,10)!==startDate)) throw fail('Invalid start date');
  if ((service && service !== current.service_purchased) || (startDate && startDate !== previousStartDate)) {
    if (!e) throw fail('Supporting evidence is required for service or start-date confirmation');
  }
  if (status==='Complete') {
    const outstanding = await db.query("SELECT r.id FROM finance_os.fundraising_requirements r LEFT JOIN finance_os.evidence e ON e.id=r.evidence_id WHERE engagement_id=$1 AND (classification NOT IN ('AVAILABLE + VERIFIED','NOT APPLICABLE') OR (classification='AVAILABLE + VERIFIED' AND (e.id IS NULL OR e.verification_status <> 'Verified' OR e.document_status <> 'Active' OR e.version IS DISTINCT FROM r.reviewed_evidence_version)))",[id]);
    if(outstanding.rows.length) throw fail('Outstanding requirements must be resolved before completion',409);
  }
  const updated = (await db.query("UPDATE finance_os.fundraising_engagements SET status=$1,version=version+1,updated_by=$2,updated_at=now(),service_purchased=$4,start_date=$5,completed_at=CASE WHEN $1='Complete' THEN now() ELSE NULL END WHERE id=$3 RETURNING *",[status,userId,id,service,startDate])).rows[0];
  await activity(id,'audit','Updated engagement status',userId,db,'Founder/admin process review',{before:current,after:updated,reason,evidence_version:e?.version ?? null},e?.id ?? null);
  return updated;
}

export async function saveScenario(id: string, input: Input, userId: string, db: Db) {
  const parent = await engagement(id,db);
  const value = validateScenario(input);
  let baseline: Holding[] | undefined;
  if (value.baseline_id) {
    const result = await db.query(`SELECT s.holdings FROM finance_os.ownership_snapshots s JOIN finance_os.evidence e ON e.id=s.evidence_id WHERE s.id=$1 AND s.company_id=$2 AND s.verification_status='VERIFIED' AND e.verification_status='Verified' AND e.document_status='Active' AND e.version=s.evidence_version AND s.effective_date <= CURRENT_DATE`,[value.baseline_id,parent.company_id]);
    if (!result.rows[0]) throw fail('Baseline requires current verified evidence and matching company');
    baseline = result.rows[0].holdings;
  }
  const calculation = calculateScenario(value.proposed_investment,value.pre_money_valuation,baseline);
  const scenario = (await db.query('INSERT INTO finance_os.fundraising_scenarios (engagement_id,name,proposed_investment,pre_money_valuation,baseline_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,value.name,value.proposed_investment,value.pre_money_valuation,value.baseline_id,value.notes,userId])).rows[0];
  await activity(id,'audit','Saved planning scenario',userId,db,'Founder/admin scenario input',{scenario,calculation});
  return {scenario,calculation};
}
