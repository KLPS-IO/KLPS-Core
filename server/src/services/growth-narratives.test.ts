import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {assessDevelopment,evidenceHash,collectDevelopments,Development} from '../growth/narrative-intake';
import {refreshNarratives,listNarratives,decideNarrative,planNarrativeContent,narrativeHistory} from '../growth/narrative.service';
import {getMissionCandidates,acceptMissionCandidate,evaluateMissionCompletion} from '../growth/mission-candidate.service';
const event:Development={kind:'rd_discovery',id:randomUUID(),state:'Discovery Completed',date:'2026-08-03T00:00:00.000Z',version:1,disclosure:'unknown',source_path:'/rd-lab/work-packages/wp1-textile-sensing'};
test('explicit states never elevate meetings, proposals, planned tests or applications into achievements',()=>{
 assert.match(assessDevelopment(event)!.evidence_summary,/not a partnership/);
 for(const state of ['Meeting Booked','Planned','Scheduled','Application Submitted','Investor conversation'])assert.equal(assessDevelopment({...event,state}),null);
 assert.match(assessDevelopment({...event,kind:'rd_quotation',state:'quotation_recorded'})!.evidence_summary,/not a supplier appointment/);
 for(const [state,verification] of [['To Validate','Unverified'],['Accepted','Under Review'],['Rejected','Verified']])assert.equal(assessDevelopment({...event,kind:'rd_finding',state,verification}),null);
 assert.match(assessDevelopment({...event,kind:'rd_finding',state:'Accepted',verification:'Verified'})!.evidence_summary,/does not establish a validated product/);
 assert.equal(assessDevelopment({...event,kind:'rd_delivery',state:'Research'}),null);
 assert.match(assessDevelopment({...event,kind:'rd_delivery',state:'Validated'})!.evidence_summary,/not a validated commercial product/);
});
test('unchanged semantic evidence retains identity; material state and disclosure changes do not',()=>{
 assert.equal(evidenceHash(event),evidenceHash({...event,version:2}));assert.notEqual(evidenceHash(event),evidenceHash({...event,disclosure:'restricted'}));
 const finding={...event,kind:'rd_finding' as const,state:'Accepted',verification:'Verified'};assert.equal(evidenceHash(finding),evidenceHash({...finding,date:'2026-10-01T00:00:00Z',version:3}));
});
const url=process.env.GROWTH_NARRATIVES_TEST_DATABASE_URL;
test('production-shaped narrative intake, decisions, provenance and Mission Control',{skip:!url},async t=>{
 const u=new URL(url!);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55481');assert.equal(u.pathname,'/growth_narratives_test');
 const db=new Pool({connectionString:url,ssl:false});const originalFetch=global.fetch;global.fetch=async()=>{throw Error('No network/provider calls permitted');};
 try{
 const {workspace,actor:user}=(await db.query("SELECT owner_user_id actor,id workspace FROM growth_os.workspaces WHERE owner_user_id=(SELECT id FROM data_room.users WHERE email='emmamendez07@gmail.com')")).rows[0];
 const sources=await collectDevelopments(workspace,db);const genuine=sources.find(e=>e.kind==='rd_discovery');assert(genuine,'Genuine canonical completed discovery is present');
 const fixture=async()=>(await db.query(`INSERT INTO rd_lab.interactions(supplier_id,work_package_id,interaction_type,occurred_at,summary,status,change_reason,created_by,updated_by)
 SELECT supplier_id,work_package_id,'Supplier Discovery Meeting',now()-interval '1 day','PRIVATE TECHNICAL SENTINEL','Discovery Completed','Local test fixture',$2,$2 FROM rd_lab.interactions WHERE id=$1 RETURNING id`,[genuine!.id,user])).rows[0].id;
 const sourceId=await fixture();
 const counts=async()=> (await db.query(`SELECT (SELECT count(*) FROM growth_os.social_publish_jobs)::int jobs,(SELECT count(*) FROM growth_os.campaigns)::int campaigns,(SELECT count(*) FROM growth_os.content_items)::int content`)).rows[0];const before=await counts();
 await t.test('refresh creates source-linked proposals; unchanged evidence and private fields do not multiply/leak',async()=>{
  await refreshNarratives(workspace,user,db);const first=(await listNarratives(workspace,db)).filter(r=>r.source_id===sourceId);assert.equal(first.length,1);assert.equal(first[0].status,'proposed');assert.equal(first[0].evidence.state,'Discovery Completed');assert.equal(first[0].insight_id,null);
  assert((await listNarratives(workspace,db)).some(r=>r.source_id===genuine!.id));
  assert.equal((await refreshNarratives(workspace,user,db)).created,0);assert.deepEqual(await counts(),before);
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE TECHNICAL SENTINEL|attendees|technical_learning|confidentiality_terms|storage_key|encrypted_access_token/);
 });
 let row=(await listNarratives(workspace,db)).find(r=>r.source_id===sourceId)!;
 await t.test('approval and ownership gates fail closed',async()=>{
  await assert.rejects(planNarrativeContent(workspace,user,row.id,{version:row.version,platform:'linkedin'},db),{code:'narrative_not_accepted'});
  await assert.rejects(decideNarrative(workspace,randomUUID(),row.id,{version:row.version,decision:'accepted',disclosure_confirmed:true},db),{code:'narrative_forbidden'});
  await assert.rejects(decideNarrative(workspace,user,row.id,{version:row.version,decision:'accepted'},db));
  await assert.rejects(decideNarrative(workspace,user,row.id,{version:row.version+1,decision:'dismissed'},db),{code:'narrative_stale'});
 });
 let reviewMission:any;
 await t.test('ranked review mission reuses existing deduplication and completion checks',async()=>{
  const match=(await getMissionCandidates(workspace,new Date(),db)).find(c=>c.candidate_type==='review_narrative_opportunity'&&c.related_entity_id===row.id);assert(match);
  reviewMission=await acceptMissionCandidate(workspace,match.deduplication_key,new Date().toISOString().slice(0,10),new Date(),db);
  await assert.rejects(acceptMissionCandidate(workspace,match.deduplication_key,new Date().toISOString().slice(0,10),new Date(),db));
  assert.equal((await evaluateMissionCompletion(workspace,reviewMission,new Date(),db)).satisfied,false);
 });
 await t.test('deferral persists and suppresses unchanged recommendations',async()=>{
  row=await decideNarrative(workspace,user,row.id,{version:row.version,decision:'deferred',deferred_until:new Date(Date.now()+86400000).toISOString()},db);
  await refreshNarratives(workspace,user,db);assert(!(await getMissionCandidates(workspace,new Date(),db)).some(c=>c.related_entity_id===row.id));
 });
 await t.test('concurrent acceptance creates one existing Insight without content or publishing side effects',async()=>{
  const input={version:row.version,decision:'accepted',disclosure_confirmed:true,business_purpose:'education',notes:'Explain discovery without naming the supplier.'};
  const results=await Promise.allSettled([decideNarrative(workspace,user,row.id,input,db),decideNarrative(workspace,user,row.id,input,db)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  row=(await listNarratives(workspace,db)).find(r=>r.id===row.id)!;assert(row.insight_id);assert.equal(row.status,'accepted');assert.deepEqual(await counts(),before);
  const insight=(await db.query('SELECT * FROM growth_os.insights WHERE id=$1',[row.insight_id])).rows[0];assert.equal(insight.source_type,'calculated');assert.match(insight.evidence,new RegExp(sourceId));
  assert.equal((await evaluateMissionCompletion(workspace,reviewMission,new Date(),db)).satisfied,true);
  const missions=await getMissionCandidates(workspace,new Date(),db);assert(missions.some(c=>c.candidate_type==='plan_narrative_content'&&c.related_entity_id===row.id));assert(!missions.some(c=>c.candidate_type==='review_insight'&&c.related_entity_id===row.insight_id));
 });
 await t.test('content planning is explicit, idempotent and produces an idea only',async()=>{
  const results=await Promise.all([planNarrativeContent(workspace,user,row.id,{version:row.version,platform:'linkedin'},db),planNarrativeContent(workspace,user,row.id,{version:row.version,platform:'linkedin'},db)]);assert.equal(results[0].content_item_id,results[1].content_item_id);
  const item=(await db.query('SELECT * FROM growth_os.content_items WHERE id=$1',[results[0].content_item_id])).rows[0];assert.equal(item.status,'idea');for(const k of ['caption','script','scheduled_at','published_at'])assert.equal(item[k],null);
  assert.equal((await counts()).jobs,before.jobs);assert.equal((await counts()).campaigns,before.campaigns);assert(!(await getMissionCandidates(workspace,new Date(),db)).some(c=>c.related_entity_id===row.id));
 });
 await t.test('confidential decisions block future versions and retain immutable decision history',async()=>{
  row=await decideNarrative(workspace,user,row.id,{version:row.version,decision:'confidential'},db);
  await db.query("UPDATE rd_lab.interactions SET occurred_at=occurred_at-interval '1 second',version=version+1 WHERE id=$1",[sourceId]);await refreshNarratives(workspace,user,db);
  assert.equal((await listNarratives(workspace,db)).filter(r=>r.source_id===sourceId).length,1);assert.equal((await db.query('SELECT status FROM growth_os.insights WHERE id=$1',[row.insight_id])).rows[0].status,'archived');
  const history=await narrativeHistory(workspace,row.id,db);for(const decision of ['accepted','planned','confidential'])assert(history.some(h=>h.decision===decision));
  await assert.rejects(db.query('DELETE FROM growth_os.narrative_decisions WHERE opportunity_id=$1',[row.id]),/append-only/);
 });
 await t.test('dismissal is permanent for unchanged evidence; changed source cannot be accepted until refreshed',async()=>{
  const id=await fixture();await refreshNarratives(workspace,user,db);let opportunity=(await listNarratives(workspace,db)).find(r=>r.source_id===id)!;
  await db.query("UPDATE rd_lab.interactions SET occurred_at=occurred_at-interval '1 second',version=version+1 WHERE id=$1",[id]);
  await assert.rejects(decideNarrative(workspace,user,opportunity.id,{version:opportunity.version,decision:'accepted',disclosure_confirmed:true},db),{code:'narrative_source_changed'});
  await refreshNarratives(workspace,user,db);opportunity=(await listNarratives(workspace,db)).find(r=>r.source_id===id&&r.current)!;
  await decideNarrative(workspace,user,opportunity.id,{version:opportunity.version,decision:'dismissed'},db);assert.equal((await refreshNarratives(workspace,user,db)).created,0);
  assert.equal((await listNarratives(workspace,db)).find(r=>r.id===opportunity.id)!.status,'dismissed');
 });
 await t.test('canonical confidentiality restrictions cannot be overridden by the approval checkbox',async()=>{
  const q=(await db.query(`INSERT INTO rd_lab.quotations(supplier_id,work_package_id,quote_reference,quote_date,confidentiality_terms,change_reason,created_by,updated_by)
 SELECT supplier_id,work_package_id,$3,current_date,'CONFIDENTIAL TERMS SENTINEL','Local fixture',$2,$2 FROM rd_lab.interactions WHERE id=$1 RETURNING id`,[genuine!.id,user,randomUUID()])).rows[0].id;
  await refreshNarratives(workspace,user,db);const opportunity=(await listNarratives(workspace,db)).find(r=>r.source_id===q)!;assert.equal(opportunity.evidence.disclosure,'restricted');assert.doesNotMatch(JSON.stringify(opportunity),/CONFIDENTIAL TERMS SENTINEL/);
  await assert.rejects(decideNarrative(workspace,user,opportunity.id,{version:opportunity.version,decision:'accepted',disclosure_confirmed:true},db),{code:'narrative_restricted'});
 });
 }finally{global.fetch=originalFetch;await db.end();}
});
