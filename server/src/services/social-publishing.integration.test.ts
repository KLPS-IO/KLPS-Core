import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { encryptSocialSecret } from '../growth/social/social.crypto';
import { approveSocialContentVariant, upsertSocialContentVariant, createPublishJob } from '../growth/social/social.service';
import { approvePublishJob, executePublishJob, getPublishJob } from '../growth/social/social-publishing.service';
const url=process.env.GROWTH_PUBLISH_TEST_DATABASE_URL;

test('production-schema X manual policy: approval, immutable credentials and blocked API execution', {skip:!url},async t=>{
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
 await t.test('approved, expired-token and read-only grants never call or refresh the paid API',async()=>{
  for(const options of [{},{expired:true},{scopes:['tweet.read','users.read','offline.access']}]) {
   normal();const f=await fixture(options);
   const before=(await db.query('SELECT to_jsonb(c) row FROM growth_os.social_connections c WHERE id=$1',[f.connection])).rows[0];
   await assert.rejects(executePublishJob(f.workspace,f.actor,f.job,f.input,db),{code:'social_manual_publishing_required'});
   const results=await Promise.allSettled([executePublishJob(f.workspace,f.actor,f.job,f.input,db),executePublishJob(f.workspace,f.actor,f.job,f.input,db)]);
   assert(results.every(r=>r.status==='rejected'));assert.equal(posts,0);assert.equal(refreshes,0);
   assert.deepEqual((await db.query('SELECT to_jsonb(c) row FROM growth_os.social_connections c WHERE id=$1',[f.connection])).rows[0],before);
   const view=await getPublishJob(f.workspace,f.job,db);assert.equal(view.status,'approved');assert.equal(view.attempt_count,0);assert.doesNotMatch(JSON.stringify(view),/initial-access|encrypted_/);
  }
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
 }finally{global.fetch=original;if(previousKey===undefined)delete process.env.GROWTH_SOCIAL_ENCRYPTION_KEY;else process.env.GROWTH_SOCIAL_ENCRYPTION_KEY=previousKey;await db.end();}
});
