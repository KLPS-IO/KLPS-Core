import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { recordAttributedVisit,registerWaitlist,acquisitionReport,isKlpsDestination,attributionTokenHash } from '../growth/acquisition.service';
import { createTrackedLink } from '../growth/community.service';
test('first-party destinations and opaque tokens fail closed',()=>{
 for(const u of ['https://klps.co.uk/','https://www.klps.co.uk/waitlist'])assert(isKlpsDestination(u));
 for(const u of ['http://klps.co.uk/','https://evil.test/','https://klps.co.uk.evil.test/','https://klps.co.uk/private','https://a:b@klps.co.uk/','javascript:alert(1)'])assert(!isKlpsDestination(u));
 for(const t of [null,'',randomUUID(),'a'.repeat(63),{}])assert.equal(attributionTokenHash(t),null);
 assert.notEqual(attributionTokenHash('a'.repeat(64)),'a'.repeat(64));
});
test('unconsented, malformed visits do not touch storage',async()=>{
 const db={query:async()=>{throw Error('Unexpected storage access');}} as any;
 assert.equal(await recordAttributedVisit({code:'a'.repeat(18),token:'b'.repeat(64)},db),null);
 assert.equal(await recordAttributedVisit({consent:true,code:'bad',token:'b'.repeat(64)},db),null);
});
const url=process.env.GROWTH_ATTRIBUTION_TEST_DATABASE_URL;
test('attribution production schema: lineage, privacy, concurrency, first acquisition and honest unknowns',{skip:!url},async t=>{
 const target=new URL(url!);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55481');assert.equal(target.pathname,'/growth_attribution_test');
 const db=new Pool({connectionString:url,ssl:false});
 const token=()=>randomBytes(32).toString('hex');
 const person=(email:string,attribution_token?:unknown)=>({name:'Local test',email,phone:null,source:'waitlist',attribution_token});
 try {
 const actor=(await db.query("INSERT INTO data_room.users(email,role) VALUES($1,'founder_admin') RETURNING id",[`${randomUUID()}@example.invalid`])).rows[0].id;
 const workspace=(await db.query("INSERT INTO growth_os.workspaces(owner_user_id,name) VALUES($1,'Attribution local test') RETURNING id",[actor])).rows[0].id;
 const campaign=(await db.query("INSERT INTO growth_os.campaigns(workspace_id,name) VALUES($1,'Campaign local test') RETURNING id",[workspace])).rows[0].id;
 const content=(await db.query("INSERT INTO growth_os.content_items(workspace_id,title,content_type,campaign_id) VALUES($1,'Content local test','text',$2) RETURNING id",[workspace,campaign])).rows[0].id;
 const link=await createTrackedLink(workspace,{label:'test',destination_url:'https://klps.co.uk/waitlist',source:'instagram',medium:'social',content_item_id:content},db);
 assert.equal(link.campaign_id,campaign);assert.equal(new URL(link.generated_url).searchParams.get('klps_ref'),link.public_code);
 await t.test('foreign or conflicting lineage cannot bind',async()=>{
  await assert.rejects(createTrackedLink(randomUUID(),{label:'bad',destination_url:'https://klps.co.uk/',source:'x',medium:'social',content_item_id:content},db));
  await assert.rejects(createTrackedLink(workspace,{label:'bad',destination_url:'https://klps.co.uk/',source:'x',medium:'social',content_item_id:content,campaign_id:randomUUID()},db));
 });
 const a=token(),b=token();
 await t.test('visit retries are idempotent and unknown/archived links do not count',async()=>{
  await Promise.all([recordAttributedVisit({code:link.public_code,token:a,consent:true},db),recordAttributedVisit({code:link.public_code,token:a,consent:true},db)]);
  assert.equal((await acquisitionReport(workspace,db)).rows[0].visits,1);
  assert.equal(await recordAttributedVisit({code:'0'.repeat(18),token:b,consent:true},db),null);
  await db.query("UPDATE growth_os.tracked_links SET status='archived' WHERE id=$1",[link.id]);
  assert.equal(await recordAttributedVisit({code:link.public_code,token:b,consent:true},db),null);
  await db.query("UPDATE growth_os.tracked_links SET status='active' WHERE id=$1",[link.id]);
 });
 const email=`${randomUUID()}@example.invalid`;
 await t.test('concurrent and case-insensitive repeat signups count exactly once; first touch is preserved',async()=>{
  await Promise.all([registerWaitlist(person(email,a),db),registerWaitlist(person(` ${email.toUpperCase()} `,a),db)]);
  const original=(await db.query('SELECT id,source,created_at,acquisition_visit_id FROM public.waitlist_signups WHERE email=$1',[email])).rows[0];
  await recordAttributedVisit({code:link.public_code,token:b,consent:true},db);
  await registerWaitlist({...person(email,b),source:'replacement'},db);
  await registerWaitlist(person(email),db);
  assert.deepEqual((await db.query('SELECT id,source,created_at,acquisition_visit_id FROM public.waitlist_signups WHERE email=$1',[email])).rows[0],original);
  const r=(await acquisitionReport(workspace,db)).rows[0];assert.equal(r.unique_signups,1);assert.equal(r.visits,2);assert.equal(r.converted_visits,1);assert.equal(r.platform,'instagram');assert.equal(r.campaign_id,campaign);assert.equal(r.content_item_id,content);
  await assert.rejects(db.query('UPDATE public.waitlist_signups SET acquisition_visit_id=NULL WHERE email=$1',[email]),/cannot be overwritten/);
 });
 await t.test('unknown first signup is never retroactively attributed and expired/forged tokens stay unknown',async()=>{
  const unknown=`${randomUUID()}@example.invalid`;await registerWaitlist(person(unknown),db);await registerWaitlist(person(unknown,a),db);
  const expired=token();await recordAttributedVisit({code:link.public_code,token:expired,consent:true},db);
  await db.query("UPDATE growth_os.tracked_link_visits SET visited_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",[attributionTokenHash(expired)]);
  for(const value of [undefined,'forged',token(),expired]) {const e=`${randomUUID()}@example.invalid`;await registerWaitlist(person(e,value),db);assert.equal((await db.query('SELECT acquisition_visit_id FROM public.waitlist_signups WHERE email=$1',[e])).rows[0].acquisition_visit_id,null);}
  assert.equal((await db.query('SELECT acquisition_visit_id FROM public.waitlist_signups WHERE email=$1',[unknown])).rows[0].acquisition_visit_id,null);
  assert.equal((await acquisitionReport(workspace,db)).rows[0].unique_signups,1);
  assert.doesNotMatch(JSON.stringify(await acquisitionReport(workspace,db)),new RegExp(`${email}|${a}|${b}|token_hash`));
 });
 } finally {await db.end();}
});
