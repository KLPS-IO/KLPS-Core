import {assertProduction} from './production-state';
import type {Pool,PoolClient} from 'pg';
import {pool} from '../storage/postgres.client';
import {listNarratives} from './narrative.service';
import {founder} from './founder-access';
import {assetFits,narrativeSequence,PLATFORMS,ROLES} from './planner-template';
type Database=Pick<Pool,'query'|'connect'>;
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{code:'planner_invalid',statusCode});
const uid=(x:unknown)=>{if(typeof x!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x))throw fail('Invalid identifier',400);return x;};
const text=(x:unknown,max=1000)=>{if(typeof x!=='string'||!x.trim()||x.length>max)throw fail('A valid planning description is required',400);return x.trim();};
async function tx<T>(workspace:string,user:string,db:Database,fn:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');await founder(c,workspace,user);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`narratives:${workspace}`]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function assertNarrativeSource(workspace:string,id:string,c:Pick<PoolClient,'query'>){const n=(await listNarratives(workspace,c)).find(r=>r.id===id);if(!n||n.status!=='accepted'||!n.current||n.evidence.disclosure==='restricted')throw fail('The source must remain accepted, current and disclosure-safe');const insight=(await c.query('SELECT status FROM growth_os.insights WHERE workspace_id=$1 AND id=$2',[workspace,n.insight_id])).rows[0];if(!insight||insight.status==='archived')throw fail('The source Insight is archived');return n;}
async function audit(c:PoolClient,w:string,u:string,n:string,details:unknown){await c.query("INSERT INTO growth_os.narrative_decisions(workspace_id,opportunity_id,actor_id,decision,details) VALUES($1,$2,$3,'planned',$4)",[w,n,u,JSON.stringify(details)]);}
export async function createNarrativePlan(w:string,u:string,input:Record<string,any>,db:Database=pool){return tx(w,u,db,async c=>{
 const n=await assertNarrativeSource(w,uid(input.opportunity_id),c);
 const existing=(await c.query('SELECT id FROM growth_os.campaigns WHERE workspace_id=$1 AND narrative_opportunity_id=$2',[w,n.id])).rows[0];if(existing)return existing;
 const platforms=input.platforms;if(!Array.isArray(platforms))throw fail('Select platforms',400);
 const start=text(input.start_date,10),end=text(input.end_date,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))throw fail('Invalid dates',400);
 let sequence;try{sequence=narrativeSequence(platforms,start,end,n.proposal.title);}catch(e){throw fail((e as Error).message,400);}
 const objective=text(input.objective??'Build qualified waitlist interest through evidence-backed education and credibility');
 const plan={source_insight_id:n.insight_id,source_opportunity_id:n.id,evidence_hash:n.evidence_hash,evidence:n.evidence,constraints:n.proposal.evidence_summary,theme:n.founder_plan.narrative,platforms,approval:'draft'};
 let campaign;
 if(input.campaign_id){campaign=(await c.query('UPDATE growth_os.campaigns SET narrative_opportunity_id=$3,narrative_plan=$4,start_date=$5,end_date=$6,objective=$7 WHERE workspace_id=$1 AND id=$2 AND narrative_opportunity_id IS NULL RETURNING *',[w,uid(input.campaign_id),n.id,JSON.stringify(plan),start,end,objective])).rows[0];if(!campaign)throw fail('Campaign is unavailable or already has a narrative plan');}
 else campaign=(await c.query("INSERT INTO growth_os.campaigns(workspace_id,name,objective,audience,core_message,status,start_date,end_date,narrative_opportunity_id,narrative_plan) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9) RETURNING *",[w,n.proposal.title,objective,n.founder_plan.audience,n.founder_plan.narrative,start,end,n.id,JSON.stringify(plan)])).rows[0];
 for(const b of sequence){await c.query("INSERT INTO growth_os.content_items(workspace_id,campaign_id,title,content_type,platform,pillar,status,research_notes,scheduled_at,platform_brief) VALUES($1,$2,$3,$4,$5,$6,'idea',$7,$8,$9)",[w,campaign.id,b.title,b.requirement.media_type==='none'?'text':b.requirement.media_type,b.platform,b.role,n.proposal.evidence_summary,b.scheduled_at,JSON.stringify({...b,source_insight_id:n.insight_id,source_opportunity_id:n.id,constraints:n.proposal.evidence_summary})]);}
 await audit(c,w,u,n.id,{action:'sequence_created',campaign_id:campaign.id,items:sequence.length});return {id:campaign.id};
});}
export async function listNarrativePlans(w:string,db:Pick<PoolClient,'query'>=pool){
 const [plans,content,assets,ns]=await Promise.all([db.query(`SELECT *, (SELECT status FROM growth_os.insights WHERE id=(growth_os.campaigns.narrative_plan->>'source_insight_id')::uuid AND workspace_id=$1) source_insight_status FROM growth_os.campaigns WHERE workspace_id=$1 AND narrative_plan IS NOT NULL ORDER BY created_at DESC`,[w]),db.query('SELECT * FROM growth_os.content_items WHERE workspace_id=$1 AND platform_brief IS NOT NULL ORDER BY scheduled_at,id',[w]),db.query(`SELECT m.*,EXISTS(SELECT 1 FROM growth_os.publishing_assets p WHERE p.workspace_id=m.workspace_id AND p.media_asset_id=m.id AND p.state<>'revoked') stored_version FROM growth_os.media_assets m WHERE m.workspace_id=$1`,[w]),listNarratives(w,db)]);
 const safeAsset=(a:Record<string,any>)=>({id:a.id,display_name:a.display_name,provenance_kind:a.provenance_kind,mime_type:a.mime_type,approved_for_use:a.approved_for_use,aspect_ratio:a.aspect_ratio,duration_seconds:a.duration_seconds,suitable_platforms:a.suitable_platforms,provenance_notes:a.provenance_notes});
 return {plans:plans.rows.map(p=>({...p,current:p.source_insight_status!=='archived'&&ns.some(n=>n.id===p.narrative_opportunity_id&&n.status==='accepted'&&n.current),items:content.rows.filter(i=>i.campaign_id===p.id).map(i=>{const candidates=assets.rows.filter(a=>assetFits(i.platform_brief,a));return {...i,asset_ready:i.platform_brief.requirement.media_type==='none'||candidates.some(a=>a.id===i.platform_brief.asset_id),suggested_assets:candidates.map(safeAsset)};})})),media:assets.rows.map(safeAsset)};
}
export async function updateNarrativePlan(w:string,u:string,id:string,input:Record<string,any>,db:Database=pool){return tx(w,u,db,async c=>{
 const p=(await c.query('SELECT * FROM growth_os.campaigns WHERE workspace_id=$1 AND id=$2 AND narrative_plan IS NOT NULL FOR UPDATE',[w,uid(id)])).rows[0];if(!p)throw fail('Plan not found',404);if(input.version!==p.planning_version)throw fail('Plan changed; reload before editing');await assertNarrativeSource(w,p.narrative_opportunity_id,c);
 const rows=(await c.query('SELECT * FROM growth_os.content_items WHERE workspace_id=$1 AND campaign_id=$2 AND platform_brief IS NOT NULL FOR UPDATE',[w,id])).rows;
 if(!Array.isArray(input.items)||input.items.length!==rows.length||new Set(input.items.map((x:any)=>x.id)).size!==rows.length)throw fail('Submit each sequence item once',400);
 const media=(await c.query(`SELECT m.*,EXISTS(SELECT 1 FROM growth_os.publishing_assets p WHERE p.workspace_id=m.workspace_id AND p.media_asset_id=m.id AND p.state<>'revoked') stored_version FROM growth_os.media_assets m WHERE m.workspace_id=$1`,[w])).rows;
 let order=0;const dates:number[]=[];
 for(const edit of input.items){const row=rows.find(r=>r.id===edit.id);if(!row)throw fail('Unknown sequence item');const b={...row.platform_brief};
  if(typeof edit.included!=='boolean'||!['pending','accepted','rejected'].includes(edit.review)||!ROLES.includes(edit.role))throw fail('Invalid item decision or role',400);
  const time=Date.parse(edit.scheduled_at);if(!Number.isFinite(time))throw fail('Invalid planned date',400);dates.push(time);
  if(!Array.isArray(edit.talking_points)||!edit.talking_points.length||edit.talking_points.length>10)throw fail('Provide one to ten talking points');b.talking_points=edit.talking_points.map((v:unknown)=>text(v,400));
  b.order=++order;b.included=edit.included;b.review=edit.review;b.role=edit.role;b.title=text(edit.title,200);b.approach=text(edit.approach,2000);b.cta=text(edit.cta,1000);
  b.asset_id=edit.asset_id?uid(edit.asset_id):null;if(b.asset_id&&!media.some(a=>a.id===b.asset_id&&assetFits(b,a)))throw fail('Asset must be approved and match the genuine-media, format and platform requirements');
  b.requirement={...b.requirement,topic:edit.topic?text(edit.topic,400):b.requirement.topic,role:b.role,deadline:new Date(time-2*86400000).toISOString()};
  if(input.approve===true&&b.included&&b.review!=='accepted')throw fail('Accept or exclude each item before approving the sequence');
  await c.query('UPDATE growth_os.content_items SET title=$3,pillar=$4,scheduled_at=$5,platform_brief=$6,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,row.id,b.title,b.role,new Date(time).toISOString(),JSON.stringify(b)]);
 }
 if(input.approve===true&&!input.items.some((i:any)=>i.included&&i.review==='accepted'))throw fail('Include at least one accepted item');
 if(dates.some((d,i)=>i>0&&d<dates[i-1]))throw fail('Dates must follow the sequence order; move the item or adjust its date');
 if(Math.max(...dates)-Math.min(...dates)>180*86400000)throw fail('Keep the sequence within 180 days');
 const plan={...p.narrative_plan,theme:input.theme?text(input.theme,300):p.narrative_plan.theme,approval:input.approve===true?'approved':'draft',platforms:[...new Set(rows.filter(r=>input.items.find((i:any)=>i.id===r.id)?.included).map(r=>r.platform))]};
 await c.query('UPDATE growth_os.campaigns SET narrative_plan=$3,planning_version=planning_version+1,planning_approved_at=$4,planning_approved_by=$5,start_date=$6,end_date=$7,objective=$8,audience=$9,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,id,JSON.stringify(plan),input.approve===true?new Date():null,input.approve===true?u:null,new Date(Math.min(...dates)).toISOString().slice(0,10),new Date(Math.max(...dates)).toISOString().slice(0,10),input.objective?text(input.objective):p.objective,input.audience?text(input.audience,300):p.audience]);
 await audit(c,w,u,p.narrative_opportunity_id,{action:input.approve===true?'sequence_approved':'sequence_edited',campaign_id:id,version:p.planning_version+1,items:input.items.map((i:any)=>({id:i.id,title:i.title,role:i.role,included:i.included,review:i.review,scheduled_at:i.scheduled_at,asset_id:i.asset_id}))});return {id};
});}
export async function profilePlanningMedia(w:string,u:string,id:string,input:Record<string,any>,db:Database=pool){return tx(w,u,db,async c=>{
 const stored=(await c.query('SELECT production_provenance FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2',[w,uid(id)])).rows[0];
 if(stored?.production_provenance&&['genuine_founder','genuine_product'].includes(input.provenance_kind))throw fail('Designed or generated production assets cannot be relabelled as genuine media');
 if(input.provenance_confirmed!==true||!['genuine_founder','genuine_product','designed','generated','unknown'].includes(input.provenance_kind))throw fail('Confirm the actual media origin');
 if(!Array.isArray(input.suitable_platforms)||input.suitable_platforms.some((p:any)=>!PLATFORMS.includes(p)))throw fail('Invalid platform suitability');
 if(!['9:16','4:5','1:1','16:9',null].includes(input.aspect_ratio))throw fail('Invalid aspect ratio');
 if(input.duration_seconds!==null&&(!Number.isInteger(input.duration_seconds)||input.duration_seconds<1||input.duration_seconds>3600))throw fail('Invalid duration');
 const r=await c.query(`UPDATE growth_os.media_assets SET provenance_kind=$3,provenance_notes=$4,suitable_platforms=$5,aspect_ratio=$6,duration_seconds=$7,provenance_history=provenance_history || jsonb_build_array(jsonb_build_object('at',now(),'actor_id',$8::text,'from',provenance_kind,'to',$3::text,'notes',$4::text)),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,[w,uid(id),input.provenance_kind,text(input.provenance_notes),JSON.stringify(input.suitable_platforms),input.aspect_ratio,input.duration_seconds,u]);if(!r.rows.length)throw fail('Media not found',404);return r.rows[0];
});}
export async function planningTimeline(w:string,db:Pick<PoolClient,'query'>=pool){
 const data=await listNarrativePlans(w,db);const manual=(await db.query('SELECT id,title,starts_at,entry_type,status,content_item_id FROM growth_os.calendar_entries WHERE workspace_id=$1 ORDER BY starts_at',[w])).rows;
 const ordinary=(await db.query('SELECT id,title,scheduled_at,platform,status FROM growth_os.content_items WHERE workspace_id=$1 AND platform_brief IS NULL AND scheduled_at IS NOT NULL',[w])).rows;
 const execution=(await db.query('SELECT j.id,j.scheduled_for,j.status,v.content_item_id,v.provider FROM growth_os.social_publish_jobs j JOIN growth_os.social_content_variants v ON v.id=j.content_variant_id AND v.workspace_id=j.workspace_id WHERE j.workspace_id=$1 AND j.scheduled_for IS NOT NULL',[w])).rows;
 return {plans:data.plans,manual,ordinary,execution,ownership:'content_items.scheduled_at is the intended content date; calendar_entries holds separate activities; social_publish_jobs.scheduled_for is a separately approved execution intent. No schedule is executed by this planner.'};
}
// Call at provider approval/execution boundaries; planning approval alone never authorises publication.
export async function assertPlannedContent(w:string,contentId:string,db:Pick<PoolClient,'query'>=pool){
 const row=(await db.query('SELECT c.platform_brief,c.campaign_id FROM growth_os.content_items c WHERE c.workspace_id=$1 AND c.id=$2',[w,contentId])).rows[0];if(!row?.platform_brief)return;
 const {plans}=await listNarrativePlans(w,db);const plan=plans.find(p=>p.id===row.campaign_id);const item=plan?.items.find((i:any)=>i.id===contentId);
 if(!plan?.current||!plan.planning_approved_at||!item?.platform_brief.included||item.platform_brief.review!=='accepted'||!item.asset_ready)throw fail('Review the current narrative plan, brief and required assets before preparing a share');
 await assertNarrativeSource(w,plan.narrative_opportunity_id,db);
 await assertProduction(w,contentId,db);
}

/** Extend the same campaign with pending briefs; never duplicate a platform's slots. */
export async function addNarrativePlatforms(w:string,u:string,id:string,input:Record<string,any>,db:Database=pool){return tx(w,u,db,async c=>{
 const p=(await c.query('SELECT * FROM growth_os.campaigns WHERE workspace_id=$1 AND id=$2 AND narrative_plan IS NOT NULL FOR UPDATE',[w,uid(id)])).rows[0];if(!p||input.version!==p.planning_version)throw fail('Plan changed; reload before editing');
 const n=await assertNarrativeSource(w,p.narrative_opportunity_id,c);
 const existing=(await c.query('SELECT DISTINCT platform FROM growth_os.content_items WHERE workspace_id=$1 AND campaign_id=$2 AND platform_brief IS NOT NULL',[w,id])).rows.map(r=>r.platform);
 if(!Array.isArray(input.platforms)||!input.platforms.length||input.platforms.some((x:any)=>!PLATFORMS.includes(x)||existing.includes(x)))throw fail('Choose platforms not already in this plan');
 const sequence=narrativeSequence(input.platforms,new Date(p.start_date).toISOString().slice(0,10),new Date(p.end_date).toISOString().slice(0,10),n.proposal.title);
 for(const b of sequence)await c.query("INSERT INTO growth_os.content_items(workspace_id,campaign_id,title,content_type,platform,pillar,status,research_notes,scheduled_at,platform_brief) VALUES($1,$2,$3,$4,$5,$6,'idea',$7,$8,$9)",[w,id,b.title,b.requirement.media_type==='none'?'text':b.requirement.media_type,b.platform,b.role,n.proposal.evidence_summary,b.scheduled_at,JSON.stringify({...b,source_insight_id:n.insight_id,source_opportunity_id:n.id,constraints:n.proposal.evidence_summary})]);
 const rows=(await c.query('SELECT id FROM growth_os.content_items WHERE workspace_id=$1 AND campaign_id=$2 AND platform_brief IS NOT NULL ORDER BY scheduled_at,platform,id',[w,id])).rows;
 for(let index=0;index<rows.length;index++)await c.query("UPDATE growth_os.content_items SET platform_brief=jsonb_set(platform_brief,'{order}',to_jsonb($3::integer)) WHERE workspace_id=$1 AND id=$2",[w,rows[index].id,index+1]);
 await c.query("UPDATE growth_os.campaigns SET planning_version=planning_version+1,planning_approved_at=NULL,planning_approved_by=NULL,narrative_plan=narrative_plan || $3::jsonb WHERE workspace_id=$1 AND id=$2",[w,id,JSON.stringify({approval:'draft',platforms:[...existing,...input.platforms]})]);
 await audit(c,w,u,n.id,{action:'platform_briefs_added',campaign_id:id,platforms:input.platforms});return {id};
});}
