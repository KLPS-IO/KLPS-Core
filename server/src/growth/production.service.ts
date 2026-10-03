import {randomUUID} from 'crypto';
import type {Pool,PoolClient} from 'pg';
import {pool} from '../storage/postgres.client';
import {founder} from './founder-access';
import {listNarrativePlans,assertNarrativeSource} from './planner.service';
import {assetFits} from './planner-template';
import {uploadPlanningMedia} from './planning-media.service';
import {deleteFromR2} from '../services/r2.service';
import {createTrackedLink} from './community.service';
import {BRAND,briefFingerprint,prepareCopy,visualGenerator,productionError as fail,GenerationRequest} from './production-generation';
import {assetFingerprint} from './production-state';
type Database=Pick<Pool,'query'|'connect'>;
const id=(x:any)=>{if(typeof x!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x))throw fail('Invalid identifier',400);return x;};
const text=(x:any,max:number)=>{if(typeof x!=='string'||x.length>max||!x.trim())throw fail('Provide valid draft text',400);return x.trim();};
export async function listProduction(w:string,db:Pick<PoolClient,'query'>=pool){const data=await listNarrativePlans(w,db);
 const assets=(await db.query('SELECT * FROM growth_os.media_assets WHERE workspace_id=$1',[w])).rows;
 for(const p of data.plans)for(const item of p.items){if(!item.production_state)continue;const hash=briefFingerprint(item,p);item.production_state={...item.production_state,candidates:item.production_state.candidates.map((x:any)=>{const a=assets.find(a=>a.id===x.media_asset_id);const current=p.current&&Boolean(p.planning_approved_at)&&item.platform_brief.included&&item.platform_brief.review==='accepted'&&x.brief_hash===hash&&!x.rejected_at&&(x.kind==='copy'||a?.approved_for_use&&x.asset_hash===assetFingerprint(a));return {...x,approval_current:Boolean(x.approved_at&&current),needs_regeneration:x.brief_hash!==hash};})};}
 return {...data,brand:BRAND,generation:{designed:'klps-designed-v1',external_enabled:false,notice:'Designed artwork uses the KLPS brand template without an external generation fee. External AI image generation needs founder cost approval.'}};}
export async function changeProduction(w:string,u:string,contentId:string,input:Record<string,any>,db:Database=pool){
 const c=await db.connect();let uploaded:string|undefined;try{
 await c.query('BEGIN');await founder(c,w,u);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`narratives:${w}`]);
 const row=(await c.query('SELECT * FROM growth_os.content_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id(contentId)])).rows[0];
 if(!row?.platform_brief)throw fail('Select an existing narrative brief',404);
 const p=(await c.query('SELECT * FROM growth_os.campaigns WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,row.campaign_id])).rows[0];
 const n=await assertNarrativeSource(w,p.narrative_opportunity_id,c),b=row.platform_brief;
 if(!p.planning_approved_at||!b.included||b.review!=='accepted')throw fail('Approve the narrative sequence and this brief before production');
 const s=row.production_state??{version:0,candidates:[],copy_id:null,asset_id:null};
 if(input.version!==s.version)throw fail('Production changed; reload before editing');
 if(s.candidates.length>=80&&['copy','visual','edit','attach'].includes(input.action))throw fail('This brief has reached its 80-candidate limit. Review existing candidates.');
 const hash=briefFingerprint(row,p),now=new Date().toISOString();
 let candidate:any=null;
 const base=(kind:string,origin:string)=>({id:randomUUID(),kind,origin,brief_hash:hash,created_at:now,created_by:u,approved_at:null,approved_by:null,rejected_at:null});
 let tracked=(await c.query('SELECT id,generated_url FROM growth_os.tracked_links WHERE workspace_id=$1 AND content_item_id=$2 AND campaign_id=$3 AND source=$4 ORDER BY created_at LIMIT 1',[w,row.id,p.id,row.platform])).rows[0];
 if(input.action==='bind_link'){
 if(b.role!=='conversion')throw fail('Only conversion briefs need a waitlist link here');
 if(!tracked)tracked=await createTrackedLink(w,{label:`${row.platform} · ${b.slot}`,destination_url:'https://klps.co.uk/waitlist',source:row.platform,medium:'social',campaign:p.name,content_item_id:row.id,campaign_id:p.id},c);
 }
 const request:GenerationRequest={content_id:row.id,brief:b,theme:p.narrative_plan.theme,evidence:n.evidence,constraints:n.proposal.evidence_summary,version:s.candidates.filter((x:any)=>x.kind===(input.action==='visual'?'asset':'copy')).length+1,tracked_link:tracked,neighbours:(await c.query('SELECT id,platform_brief->>\'role\' role,platform_brief->>\'slot\' slot FROM growth_os.content_items WHERE campaign_id=$1 AND workspace_id=$2 AND platform=$3 ORDER BY scheduled_at',[p.id,w,row.platform])).rows,approved_assets:(await c.query('SELECT id FROM growth_os.media_assets WHERE workspace_id=$1 AND approved_for_use=true',[w])).rows.map(x=>x.id)};
 if(input.action==='copy'){
 candidate={...base('copy','generated_copy'),...prepareCopy(request),request,provider:'evidence-template-v1'};s.candidates.push(candidate);s.copy_id=candidate.id;
 }else if(input.action==='visual'){
 const provider=visualGenerator(input.provider??'klps-designed-v1');const result=await provider.generate(request,prepareCopy(request));
 const asset=await uploadPlanningMedia(w,result.bytes,`KLPS ${b.slot} visual ${request.version}.jpg`,c);uploaded=asset.id;
 const provenance={content_id:row.id,campaign_id:p.id,opportunity_id:n.id,insight_id:n.insight_id,request,provider:provider.id,brand_version:BRAND.version,origin:result.origin,provider_result:result.provenance??null};
 await c.query("UPDATE growth_os.media_assets SET provenance_kind=$3,provenance_notes=$4,aspect_ratio='4:5',suitable_platforms=$5,production_provenance=$6 WHERE workspace_id=$1 AND id=$2",[w,asset.id,result.origin,`KLPS brand artwork; ${provider.id}; no genuine footage represented`,JSON.stringify([row.platform]),JSON.stringify(provenance)]);
 candidate={...base('asset',result.origin==='designed'?'designed_visual':'generated_visual'),media_asset_id:asset.id,request,provider:provider.id,alt:prepareCopy(request).alt};s.candidates.push(candidate);s.asset_id=candidate.id;
 }else if(input.action==='attach'){
 const a=(await c.query('SELECT * FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2',[w,id(input.media_asset_id)])).rows[0];
 if(!a||!assetFits(b,{...a,approved_for_use:true}))throw fail('Record matching media provenance and format in the existing media library first');
 candidate={...base('asset',['genuine_founder','genuine_product'].includes(a.provenance_kind)?input.edited===true?'edited_genuine_media':'genuine_media':a.provenance_kind==='generated'?'generated_visual':'designed_visual'),media_asset_id:a.id,edit_notes:input.edited===true?text(input.edit_notes,1000):null};s.candidates.push(candidate);s.asset_id=candidate.id;
 }else if(['edit','select','reject','approve'].includes(input.action)){
 const old=s.candidates.find((x:any)=>x.id===input.candidate_id);if(!old)throw fail('Candidate not found',404);
 if(input.action==='edit'){
 if(old.kind!=='copy')throw fail('Replace visual media with a new candidate');
 candidate={...old,...base('copy','edited_copy'),parent_id:old.id,caption:text(input.caption,3000),script:typeof input.script==='string'?input.script.slice(0,8000):old.script};s.candidates.push(candidate);s.copy_id=candidate.id;
 }else if(input.action==='reject'){old.rejected_at=now;old.approved_at=null;old.approved_by=null;}
 else {
 if(old.rejected_at||old.brief_hash!==hash)throw fail('Candidate is rejected or its brief changed; prepare a new candidate');
 s[old.kind==='copy'?'copy_id':'asset_id']=old.id;
 if(input.action==='approve'){
 if(input.confirmed!==true)throw fail('Confirm evidence, disclosure and the actual candidate before approval');
 if(old.kind==='asset'){
 const a=(await c.query('SELECT * FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,old.media_asset_id])).rows[0];
 if(!a||!assetFits(b,{...a,approved_for_use:true}))throw fail('Asset origin, format and platform must match this brief');
 await c.query('UPDATE growth_os.media_assets SET approved_for_use=true,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,a.id]);old.asset_hash=assetFingerprint(a);b.asset_id=a.id;
 }
 old.approved_at=now;old.approved_by=u;
 }
 }
 }else if(input.action!=='bind_link')throw fail('Unknown production action',400);
 s.version++;
 const selected=s.candidates.find((x:any)=>x.id===s.copy_id);
 // Every selected draft remains in Studio. No provider variant/job is created or approved here.
 await c.query('UPDATE growth_os.content_items SET production_state=$3,platform_brief=$4,caption=$5,script=$6,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,row.id,JSON.stringify(s),JSON.stringify(b),selected?.caption??row.caption,selected?.script??row.script]);
 await c.query("INSERT INTO growth_os.narrative_decisions(workspace_id,opportunity_id,actor_id,decision,details) VALUES($1,$2,$3,'planned',$4)",[w,n.id,u,JSON.stringify({action:`production_${input.action}`,content_id:row.id,version:s.version,candidate_id:candidate?.id??input.candidate_id??null})]);
 await c.query('COMMIT');return {id:row.id,version:s.version,tracked_link:tracked??null};
 }catch(e){await c.query('ROLLBACK');if(uploaded)await deleteFromR2(`growth-source/${w}/${uploaded}.jpg`).catch(()=>undefined);throw e;}finally{c.release();}
}
