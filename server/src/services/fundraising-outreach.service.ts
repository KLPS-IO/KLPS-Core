import { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { fail, required, uuid } from './fundraising-readiness.service';
type Db = Pick<PoolClient,'query'>;
export const UPDATE_CATEGORIES = ['SEIS / Advance Assurance','Technical validation','Prototype','Supplier / manufacturing','Customer / research traction','Fundraising milestone'] as const;
export const OUTREACH_STAGES = ['DISTRIBUTED TO INVESTOR COMMUNITY','INVESTOR CONTACT','INVESTOR CONVERSATION','DUE DILIGENCE','PROPOSED INVESTMENT','COMMITMENT','SIGNED INVESTMENT','CASH RECEIVED','SHARE ISSUANCE'] as const;

export function validateUpdate(input:Record<string,unknown>) {
  if(Object.keys(input).some(k=>!['category','description','evidence_id','occurred_on'].includes(k))) throw fail('Unsupported update field; this operation cannot approve or send communication');
  if(!(UPDATE_CATEGORIES as readonly unknown[]).includes(input.category)) throw fail('Choose a significant-update category');
  const date=required(input.occurred_on,'Milestone date');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>new Date().toISOString().slice(0,10))throw fail('An evidenced, non-future milestone date is required');
  return {category:input.category as string,description:required(input.description,'Milestone description'),evidence_id:uuid(input.evidence_id),occurred_on:date};
}
export async function getOutreach(db:Db=pool) {
  const channel=(await db.query("SELECT g.id,g.provider,g.purpose FROM finance_os.fundraising_engagements g JOIN finance_os.company c ON c.id=g.company_id WHERE c.company_number='16436591' AND g.provider='Alma Angels'")).rows[0];
  if(!channel)return {channel:null,events:[],update_categories:UPDATE_CATEGORIES};
  const events=(await db.query(`SELECT a.id,a.kind,a.description,a.occurred_on::text AS occurred_on,a.recorded_at,a.evidence_id,a.payload,e.verification_status,e.document_status,e.version AS current_evidence_version FROM finance_os.fundraising_activity a LEFT JOIN finance_os.evidence e ON e.id=a.evidence_id WHERE a.engagement_id=$1 ORDER BY a.recorded_at,a.id`,[channel.id])).rows;
  const distribution=events.find(e=>e.payload?.event_key==='alma-distribution-20260917');
  const verified=!!distribution&&distribution.verification_status==='Verified'&&distribution.document_status==='Active'&&distribution.current_evidence_version===distribution.payload.evidence_version;
  // Return a deliberate projection, never email headers, source hashes or general community statistics as KPIs.
  return {channel:{...channel,stage:verified?'DISTRIBUTED TO INVESTOR COMMUNITY':'EVIDENCE REVIEW REQUIRED',event_date:distribution?.occurred_on??null,evidence_id:distribution?.evidence_id??null,verified},
    events:events.map(e=>({id:e.id,kind:e.kind,description:e.description,occurred_on:e.occurred_on,recorded_at:e.recorded_at,evidence_id:e.evidence_id,category:e.payload?.category??null,communication_status:e.payload?.communication_status??'NOT SENT',evidence_current:e.verification_status==='Verified'&&e.document_status==='Active'&&e.current_evidence_version===e.payload?.evidence_version})),
    update_categories:UPDATE_CATEGORIES,stages:OUTREACH_STAGES,automatic_progression:false,external_sending_supported:false};
}
export async function recordUpdate(id:string,input:Record<string,unknown>,actor:string,db:Db) {
  const value=validateUpdate(input);
  const channel=(await db.query("SELECT g.id FROM finance_os.fundraising_engagements g JOIN finance_os.company c ON c.id=g.company_id WHERE g.id=$1 AND c.company_number='16436591' AND g.provider='Alma Angels' FOR SHARE",[uuid(id)])).rows[0];
  if(!channel)throw fail('Alma channel not found',404);
  const evidence=(await db.query("SELECT id,version FROM finance_os.evidence WHERE id=$1 AND verification_status='Verified' AND document_status='Active' FOR SHARE",[value.evidence_id])).rows[0];
  if(!evidence)throw fail('Active verified evidence is required for a milestone');
  return (await db.query(`INSERT INTO finance_os.fundraising_activity(engagement_id,kind,description,evidence_id,occurred_on,recorded_by,source,payload) VALUES ($1,'milestone',$2,$3,$4,$5,'Founder/admin significant update candidate',$6) RETURNING id`,[channel.id,value.description,evidence.id,value.occurred_on,actor,JSON.stringify({category:value.category,evidence_version:evidence.version,communication_status:'DRAFT — FOUNDER APPROVAL REQUIRED',sent_at:null,effect:'RECORD_ONLY'})])).rows[0];
}
