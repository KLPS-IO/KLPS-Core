import type {Pool,PoolClient} from 'pg';
import {pool} from '../storage/postgres.client';
import {assessDevelopment,collectDevelopments,evidenceHash} from './narrative-intake';
type Database=Pick<Pool,'query'|'connect'>;
const fail=(message:string,code='narrative_invalid',statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const uuid=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v))throw fail('Invalid record identifier');return v;};
async function transaction<T>(db:Database,fn:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function owner(workspace:string,user:string,c:PoolClient){if(!(await c.query(`SELECT w.id FROM growth_os.workspaces w JOIN data_room.users u ON u.id=w.owner_user_id WHERE w.id=$1 AND u.id=$2 AND u.role='founder_admin' AND coalesce(u.is_active,true) AND (u.expires_at IS NULL OR u.expires_at>now())`,[workspace,user])).rows.length)throw fail('Workspace founder access required','narrative_forbidden',403);}
async function audit(c:PoolClient,workspace:string,id:string,user:string,decision:string,details:unknown){await c.query(`INSERT INTO growth_os.narrative_decisions(workspace_id,opportunity_id,actor_id,decision,details) VALUES($1,$2,$3,$4,$5)`,[workspace,id,user,decision,JSON.stringify(details)]);}
export async function refreshNarratives(workspace:string,user:string,db:Database=pool){return transaction(db,async c=>{
 await owner(workspace,user,c);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`narratives:${workspace}`]);
 const events=await collectDevelopments(workspace,c),rows=(await c.query('SELECT * FROM growth_os.narrative_opportunities WHERE workspace_id=$1 FOR UPDATE',[workspace])).rows;
 const blocked=new Set(rows.filter(r=>r.status==='confidential').map(r=>`${r.source_kind}:${r.source_id}`));
 const current=new Set(events.map(e=>`${e.kind}:${e.id}:${evidenceHash(e)}`));let created=0,superseded=0;
 for(const row of rows){if(['proposed','accepted','deferred'].includes(row.status)&&!current.has(`${row.source_kind}:${row.source_id}:${row.evidence_hash}`)){
  await c.query("UPDATE growth_os.narrative_opportunities SET status='superseded',version=version+1,updated_at=now() WHERE id=$1",[row.id]);
  if(row.insight_id)await c.query("UPDATE growth_os.insights SET status='archived' WHERE id=$1 AND workspace_id=$2",[row.insight_id,workspace]);
  await audit(c,workspace,row.id,user,'superseded',{reason:'Canonical state changed, was removed or is no longer eligible.'});superseded++;
 }}
 for(const event of events){const proposal=assessDevelopment(event);if(!proposal||blocked.has(`${event.kind}:${event.id}`))continue;
  // Preserve a source-level deferral even if new evidence arrives before its date.
  const prior=rows.find(r=>r.source_kind===event.kind&&r.source_id===event.id&&r.status==='deferred'&&new Date(r.deferred_until).getTime()>Date.now());
  const r=await c.query(`INSERT INTO growth_os.narrative_opportunities(workspace_id,source_kind,source_id,evidence_hash,evidence,proposal,status,deferred_until)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,source_kind,source_id,evidence_hash) DO NOTHING RETURNING id`,[workspace,event.kind,event.id,evidenceHash(event),JSON.stringify(event),JSON.stringify(proposal),prior?'deferred':'proposed',prior?.deferred_until??null]);created+=r.rows.length;
 }
 return {created,superseded};
});}
export async function listNarratives(workspace:string,db:Pick<PoolClient,'query'>=pool){
 const [records,events]=await Promise.all([db.query('SELECT * FROM growth_os.narrative_opportunities WHERE workspace_id=$1 ORDER BY created_at DESC',[workspace]),collectDevelopments(workspace,db)]);
 const hashes=new Set(events.map(e=>`${e.kind}:${e.id}:${evidenceHash(e)}`));
 return records.rows.map(r=>({...r,current:hashes.has(`${r.source_kind}:${r.source_id}:${r.evidence_hash}`)}));
}
const purposes=['awareness','education','credibility_nurture','conversion'];
const narratives=['founder_build_journey','rd_progress','customer_insight','credibility','supplier_progress','education','waitlist_opportunity'];
const audiences=['prospective_waitlist_members','community','business_partners'];
const timings=['after_disclosure_review','next_content_cycle','after_supporting_assets'];
function planInput(input:Record<string,unknown>,proposal:Record<string,any>){
 const out:Record<string,unknown>={};for(const [key,allowed] of Object.entries({business_purpose:purposes,narrative:narratives,audience:audiences,timing:timings})){const value=input[key]??proposal[key];if(typeof value!=='string'||!allowed.includes(value))throw fail(`Invalid ${key}`);out[key]=value;}
 const platforms=input.platforms??proposal.platforms;if(!Array.isArray(platforms)||!platforms.length||platforms.some(p=>!['linkedin','facebook','instagram','tiktok','x','snapchat'].includes(p)))throw fail('Choose valid platforms');out.platforms=[...new Set(platforms)];
 const notes=input.notes??'';if(typeof notes!=='string'||notes.length>1500)throw fail('Founder notes must be at most 1500 characters');out.notes=notes.trim();return out;
}
async function locked(workspace:string,id:string,version:unknown,c:PoolClient){const row=(await c.query('SELECT * FROM growth_os.narrative_opportunities WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspace,uuid(id)])).rows[0];if(!row)throw fail('Opportunity not found','narrative_not_found',404);if(!Number.isInteger(version)||row.version!==version)throw fail('This opportunity changed. Reload and review it again.','narrative_stale',409);return row;}
async function current(row:Record<string,any>,c:PoolClient){const event=(await collectDevelopments(row.workspace_id,c)).find(e=>e.kind===row.source_kind&&e.id===row.source_id);if(!event||evidenceHash(event)!==row.evidence_hash)throw fail('The canonical evidence changed. Check company developments again.','narrative_source_changed',409);return event;}
export async function decideNarrative(workspace:string,user:string,id:string,input:Record<string,unknown>,db:Database=pool){return transaction(db,async c=>{
 await owner(workspace,user,c);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`narratives:${workspace}`]);const row=await locked(workspace,id,input.version,c);
 const decision=input.decision;if(!['accepted','dismissed','deferred','confidential'].includes(String(decision)))throw fail('Choose a founder decision');
 if(!['proposed','deferred'].includes(row.status)&&!(decision==='confidential'&&row.status==='accepted'))throw fail('This opportunity already has a decision','narrative_decided',409);
 let insight=row.insight_id,plan=null,until=null;
 if(decision==='accepted'){
  const event=await current(row,c);if(event.disclosure==='restricted')throw fail('The canonical source has disclosure restrictions. Keep this internal.','narrative_restricted',409);
  if(input.disclosure_confirmed!==true)throw fail('Explicit review of evidence and disclosure is required');
  plan=planInput(input,row.proposal);
  const result=await c.query(`INSERT INTO growth_os.insights(workspace_id,category,title,evidence,recommended_decision,confidence,source_type,status)
 VALUES($1,$2,$3,$4,$5,$6,'calculated','active') RETURNING id`,[workspace,plan.narrative,row.proposal.title,`${row.proposal.evidence_summary}\nRecorded date: ${row.evidence.date}\nCanonical source: ${row.source_kind} / ${row.source_id} / version ${row.evidence.version??'not versioned'}\nInternal provenance: ${row.evidence.source_path}`,
 `Founder-approved narrative planning: ${plan.narrative}; purpose ${plan.business_purpose}; audience ${plan.audience}. Prepare an idea in Intelligence; do not publish. Founder notes: ${plan.notes}`,row.proposal.confidence]);insight=result.rows[0].id;
 }
 if(decision==='deferred'){if(typeof input.deferred_until!=='string'||!Number.isFinite(Date.parse(input.deferred_until))||Date.parse(input.deferred_until)<=Date.now()||Date.parse(input.deferred_until)>Date.now()+90*86400000)throw fail('Choose a future date within 90 days');until=input.deferred_until;}
 if(decision==='confidential'&&insight)await c.query("UPDATE growth_os.insights SET status='archived' WHERE id=$1 AND workspace_id=$2",[insight,workspace]);
 const result=await c.query(`UPDATE growth_os.narrative_opportunities SET status=$3,founder_plan=coalesce($4::jsonb,founder_plan),deferred_until=$5,insight_id=$6,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,[workspace,id,decision,plan?JSON.stringify(plan):null,until,insight]);
 await audit(c,workspace,id,user,String(decision),{plan,deferred_until:until,disclosure_confirmed:input.disclosure_confirmed===true,insight_id:insight});return result.rows[0];
});}
export async function planNarrativeContent(workspace:string,user:string,id:string,input:Record<string,unknown>,db:Database=pool){return transaction(db,async c=>{
 await owner(workspace,user,c);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`narratives:${workspace}`]);const row=await locked(workspace,id,input.version,c);
 if(row.status!=='accepted')throw fail('Accept this opportunity first','narrative_not_accepted',409);await current(row,c);
 if(row.content_item_id)return {content_item_id:row.content_item_id};
 const platform=input.platform;if(typeof platform!=='string'||!row.founder_plan.platforms.includes(platform))throw fail('Choose a reviewed platform');
 const campaign=input.campaign_id?uuid(input.campaign_id):null;if(campaign&&!(await c.query('SELECT id FROM growth_os.campaigns WHERE id=$1 AND workspace_id=$2',[campaign,workspace])).rows.length)throw fail('Campaign must belong to this workspace');
 const record=await c.query(`INSERT INTO growth_os.content_items(workspace_id,campaign_id,title,content_type,platform,status,pillar,research_notes)
 VALUES($1,$2,$3,$4,$5,'idea',$6,$7) RETURNING id`,[workspace,campaign,row.proposal.title,['tiktok','snapchat'].includes(platform)?'video':platform==='instagram'?'image':'text',platform,row.founder_plan.narrative,
 `${row.proposal.evidence_summary}\nNarrative opportunity: ${row.id}; insight: ${row.insight_id}. Source: ${row.evidence.source_path} / ${row.source_id}.\nPurpose: ${row.founder_plan.business_purpose}; audience: ${row.founder_plan.audience}; timing: ${row.founder_plan.timing}.\nFounder planning notes: ${row.founder_plan.notes}\nPrepare supporting evidence/assets and review platform-native content separately. No final copy or publishing approval has been generated.`]);
 const contentId=record.rows[0].id;await c.query('UPDATE growth_os.narrative_opportunities SET content_item_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2',[workspace,id,contentId]);
 await c.query("UPDATE growth_os.insights SET status='actioned' WHERE workspace_id=$1 AND id=$2",[workspace,row.insight_id]);await audit(c,workspace,id,user,'planned',{content_item_id:contentId,campaign_id:campaign,platform});return {content_item_id:contentId};
});}
export async function narrativeHistory(workspace:string,id:string,db:Pick<PoolClient,'query'>=pool){return (await db.query('SELECT decision,details,created_at FROM growth_os.narrative_decisions WHERE workspace_id=$1 AND opportunity_id=$2 ORDER BY created_at',[workspace,uuid(id)])).rows;}
