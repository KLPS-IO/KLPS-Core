import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { encryptSocialSecret, decryptSocialSecret } from '../growth/social/social.crypto';
import { approveSocialContentVariant, upsertSocialContentVariant, createPublishJob } from '../growth/social/social.service';
import { approvePublishJob, executePublishJob, getPublishJob } from '../growth/social/social-publishing.service';
const url=process.env.GROWTH_PUBLISH_TEST_DATABASE_URL;

test('production-schema publish execution: approval, encryption, failures and concurrency', {skip:!url},async t=>{
 const target=new URL(url!);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55481');assert.equal(target.pathname,'/growth_x_publish_test');
 const db=new Pool({connectionString:url,ssl:false});const original=global.fetch,previousKey=process.env.GROWTH_SOCIAL_ENCRYPTION_KEY;
 process.env.GROWTH_SOCIAL_ENCRYPTION_KEY=Buffer.alloc(32,17).toString('base64');process.env.X_CLIENT_ID='test-client';process.env.X_CLIENT_SECRET='test-secret';
 let posts=0,refreshes=0;
 function normal(){posts=0;refreshes=0;global.fetch=async(input)=>{
  const path=String(input);if(path==='https://api.x.com/2/oauth2/token'){refreshes++;return new Response(JSON.stringify({access_token:'refreshed-access',refresh_token:'rotated-refresh',expires_in:7200,scope:'tweet.read users.read offline.access tweet.write'}),{status:200});}
  assert.equal(path,'https://api.x.com/2/tweets');posts++;return new Response(JSON.stringify({data:{id:'99887766'}}),{status:201});
 };}
 async function fixture(options:{scopes?:string[];expired?:boolean;approve?:boolean;text?:string}={}){
  const actor=(await db.query("INSERT INTO data_room.users(email,role) VALUES($1,'founder_admin') RETURNING id",[`x-${randomUUID()}@example.invalid`])).rows[0].id;
  const workspace=(await db.query("INSERT INTO growth_os.workspaces(owner_user_id,name,timezone) VALUES($1,'Publishing test','Europe/London') RETURNING id",[actor])).rows[0].id;
  const account=String(Date.now())+Math.floor(Math.random()*100000);
  const connection=(await db.query(`INSERT INTO growth_os.social_connections(workspace_id,provider,provider_account_id,provider_account_name,provider_account_type,status,encrypted_access_token,encrypted_refresh_token,token_expires_at,granted_scopes,discovered_capabilities,last_successful_check_at)
   VALUES($1,'x',$2,'Test founder','member','connected',$3,$4,$5,$6,'{text,direct_publishing}',now()) RETURNING id`,[workspace,account,encryptSocialSecret('initial-access'),encryptSocialSecret('initial-refresh'),new Date(Date.now()+(options.expired?-1000:3600000)),options.scopes??['tweet.read','users.read','offline.access','tweet.write']])).rows[0].id;
  const source=(await db.query("INSERT INTO growth_os.content_items(workspace_id,title,content_type) VALUES($1,'Test text','text') RETURNING id",[workspace])).rows[0].id;
  const variant=await upsertSocialContentVariant(workspace,source,'x',{copy:options.text??'Approved text',media_references:[],destination_reference:account},db);
  const job=await createPublishJob(workspace,actor,{connection_id:connection,content_variant_id:variant.id},db);
  const view=await getPublishJob(workspace,job.id,db);
  const input={confirm_publish:true,expected_fingerprint:view.current_fingerprint};
  if(options.approve!==false){await approveSocialContentVariant(workspace,actor,variant.id,{copy_approved:true,media_approved:true},db);await approvePublishJob(workspace,actor,job.id,view.current_fingerprint,db);}
  return {workspace,actor,source,account,connection,variant:variant.id,job:job.id,input};
 }
 try {
 await t.test('generated or connected content never posts without both approvals and explicit publish confirmation',async()=>{
  normal();const f=await fixture({approve:false});await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));
  await approveSocialContentVariant(f.workspace,f.actor,f.variant,{copy_approved:true,media_approved:true},db);
  await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));
  await approvePublishJob(f.workspace,f.actor,f.job,f.input.expected_fingerprint,db);
  await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,{...f.input,confirm_publish:false},db));assert.equal(posts,0);
 });
 await t.test('published result and audit are durable, secrets are absent and replay does not dispatch',async()=>{
  normal();const f=await fixture();const result=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);
  assert.equal(result.status,'published');assert.equal(result.provider_post_id,'99887766');assert.equal(result.execution_state,'succeeded');
  const replay=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(replay.provider_post_id,result.provider_post_id);assert.equal(posts,1);
  assert.doesNotMatch(JSON.stringify(result),/initial-access|initial-refresh|encrypted_/);
  const audit=(await db.query('SELECT event_type,outcome,safe_details FROM growth_os.social_audit_events WHERE workspace_id=$1',[f.workspace])).rows;
  assert(audit.some(a=>a.event_type==='publish_execution'&&a.outcome==='success'));assert.doesNotMatch(JSON.stringify(audit),/initial-access|initial-refresh/);
  assert.equal((await db.query('SELECT count(*)::int n FROM growth_os.social_metric_snapshots WHERE workspace_id=$1',[f.workspace])).rows[0].n,0);
 });
 await t.test('expired credentials rotate atomically before one publish',async()=>{
  normal();const f=await fixture({expired:true});await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(refreshes,1);assert.equal(posts,1);
  const c=(await db.query('SELECT * FROM growth_os.social_connections WHERE id=$1',[f.connection])).rows[0];assert.equal(decryptSocialSecret(c.encrypted_access_token),'refreshed-access');assert.equal(decryptSocialSecret(c.encrypted_refresh_token),'rotated-refresh');
 });
 await t.test('refresh failure preserves encrypted credentials but blocks all posting until reauthorisation',async()=>{
  normal();const f=await fixture({expired:true});global.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant',private:'secret'}),{status:400});await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));
  const c=(await db.query('SELECT * FROM growth_os.social_connections WHERE id=$1',[f.connection])).rows[0];assert.equal(c.status,'expired');assert.equal(decryptSocialSecret(c.encrypted_refresh_token),'initial-refresh');assert.equal((await getPublishJob(f.workspace,f.job,db)).attempt_count,0);
 });
 await t.test('refresh scope downgrade cannot retain write capability',async()=>{
  normal();const f=await fixture({expired:true});global.fetch=async()=>new Response(JSON.stringify({access_token:'downgraded',refresh_token:'rotated',expires_in:7200,scope:'tweet.read users.read offline.access'}),{status:200});
  await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));const c=(await db.query('SELECT * FROM growth_os.social_connections WHERE id=$1',[f.connection])).rows[0];assert.deepEqual(c.discovered_capabilities,[]);assert.equal((await getPublishJob(f.workspace,f.job,db)).attempt_count,0);
 });
 await t.test('read-only authorisation, changed text, changed account, revoked approval and other founders are blocked',async()=>{
  for(const change of ['scope','text','account','approval','actor']){
   normal();const f=await fixture();
   if(change==='scope')await db.query("UPDATE growth_os.social_connections SET granted_scopes='{tweet.read,users.read,offline.access}' WHERE id=$1",[f.connection]);
   if(change==='text')await upsertSocialContentVariant(f.workspace,f.source,'x',{copy:'Changed text',media_references:[],destination_reference:f.account},db);
   if(change==='account')await db.query("UPDATE growth_os.social_connections SET provider_account_id='999999999' WHERE id=$1",[f.connection]);
   if(change==='approval')await approveSocialContentVariant(f.workspace,f.actor,f.variant,{copy_approved:false,media_approved:false},db);
   await assert.rejects(executePublishJob(f.workspace,change==='actor'?randomUUID():f.actor,f.job,f.input,db));assert.equal(posts,0);
  }
 });
 await t.test('concurrent duplicate requests can dispatch only once',async()=>{
  normal();const f=await fixture();const result=await Promise.allSettled([executePublishJob(f.workspace,f.actor,f.job,f.input,db),executePublishJob(f.workspace,f.actor,f.job,f.input,db)]);assert.equal(posts,1);assert(result.some(r=>r.status==='fulfilled'&&r.value.status==='published'));
 });
 await t.test('a second job with the same account and text cannot publish again',async()=>{
  normal();const f=await fixture();await executePublishJob(f.workspace,f.actor,f.job,f.input,db);
  const duplicate=await createPublishJob(f.workspace,f.actor,{connection_id:f.connection,content_variant_id:f.variant},db);
  await approvePublishJob(f.workspace,f.actor,duplicate.id,f.input.expected_fingerprint,db);
  await assert.rejects(executePublishJob(f.workspace,f.actor,duplicate.id,f.input,db),{code:'social_duplicate_publish'});assert.equal(posts,1);
 });
 await t.test('network uncertainty and server errors remain blocked even through another job',async()=>{
  for(const mode of ['network','server']){normal();const f=await fixture();global.fetch=async()=>{posts++;if(mode==='network')throw Error('private-token');return new Response('failure',{status:503});};
   const result=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(result.execution_state,'unknown');assert.equal(result.needs_review,true);assert.equal(posts,1);
   await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));assert.equal(posts,1);
   const other=await createPublishJob(f.workspace,f.actor,{connection_id:f.connection,content_variant_id:f.variant},db);await approvePublishJob(f.workspace,f.actor,other.id,f.input.expected_fingerprint,db);await assert.rejects(executePublishJob(f.workspace,f.actor,other.id,f.input,db),{code:'social_duplicate_publish'});assert.equal(posts,1);
  }
 });
 await t.test('known rate limit has bounded explicit retry, cooldown and no autonomous retry',async()=>{
  normal();const f=await fixture();global.fetch=async()=>{posts++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});};
  let result=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(result.status,'retry');assert.equal(posts,1);
  await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db),{code:'social_retry_not_due'});assert.equal(posts,1);
  await db.query("UPDATE growth_os.social_publish_jobs SET retry_after=now()-interval '1 second' WHERE id=$1",[f.job]);
  global.fetch=async()=>{posts++;return new Response(JSON.stringify({data:{id:'99'}}),{status:201});};result=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(result.status,'published');assert.equal(posts,2);
 });
 await t.test('401 requires reauthorisation and a deliberate retry; a newer grant is never expired by the old response',async()=>{
  for(const reconnectDuringPost of [false,true]) {
   normal();const f=await fixture();global.fetch=async()=>{posts++;
    if(reconnectDuringPost)await db.query("UPDATE growth_os.social_connections SET encrypted_access_token=$2 WHERE id=$1",[f.connection,encryptSocialSecret('fresh-reauthorisation')]);
    return new Response('{}',{status:401});
   };
   const result=await executePublishJob(f.workspace,f.actor,f.job,f.input,db);assert.equal(result.status,'retry');assert.equal(posts,1);
   const c=(await db.query('SELECT status FROM growth_os.social_connections WHERE id=$1',[f.connection])).rows[0];assert.equal(c.status,reconnectDuringPost?'connected':'expired');
   if(!reconnectDuringPost)await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));assert.equal(posts,1);
   await db.query("UPDATE growth_os.social_connections SET status='connected',encrypted_access_token=$2 WHERE id=$1",[f.connection,encryptSocialSecret('fresh-reauthorisation')]);
   global.fetch=async()=>{posts++;return new Response(JSON.stringify({data:{id:'12345'}}),{status:201});};
   assert.equal((await executePublishJob(f.workspace,f.actor,f.job,f.input,db)).status,'published');assert.equal(posts,2);
  }
 });
 await t.test('manual retries stop after three provider rejections',async()=>{
  normal();const f=await fixture();global.fetch=async()=>{posts++;return new Response('{}',{status:429});};
  for(let attempt=0;attempt<3;attempt++) {await executePublishJob(f.workspace,f.actor,f.job,f.input,db);await db.query("UPDATE growth_os.social_publish_jobs SET retry_after=now()-interval '1 second' WHERE id=$1",[f.job]);}
  await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db),{code:'social_retry_limit'});assert.equal(posts,3);
 });
 await t.test('in-flight crash marker cannot dispatch',async()=>{
  normal();const f=await fixture();await db.query("UPDATE growth_os.social_publish_jobs SET status='publishing',execution_state='in_flight' WHERE id=$1",[f.job]);await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db));assert.equal(posts,0);
 });
 }finally{global.fetch=original;if(previousKey===undefined)delete process.env.GROWTH_SOCIAL_ENCRYPTION_KEY;else process.env.GROWTH_SOCIAL_ENCRYPTION_KEY=previousKey;await db.end();}
});
