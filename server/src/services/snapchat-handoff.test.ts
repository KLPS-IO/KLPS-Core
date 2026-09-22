import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {encryptSocialSecret} from '../growth/social/social.crypto';
import {snapchatHandoffCapabilities,snapchatShareHtml,validateSnapchatHandoff} from '../growth/social/snapchat-handoff.adapter';
import {prepareHandoff,readHandoff} from '../growth/social/social-handoff.service';
import {upsertSocialContentVariant,approveSocialContentVariant,createPublishJob} from '../growth/social/social.service';
import {approvePublishJob,getPublishJob,executePublishJob} from '../growth/social/social-publishing.service';
// Match the existing production Login Kit grant; /me verified the external ID.
const scopes=['https://auth.snapchat.com/oauth2/api/user.display_name'];
test('Creative Kit capability is manual only; content and metadata are validated and HTML escaped',()=>{
 assert.deepEqual(snapchatHandoffCapabilities(scopes),['manual_handoff']);assert.deepEqual(snapchatHandoffCapabilities([]),['manual_handoff']);
 validateSnapchatHandoff({text:'Approved link',media:[]});
 for(const value of [{text:'',media:[]},{text:'a'.repeat(501),media:[]},{text:'hi',media:[{url:'https://private.invalid'}]}])assert.throws(()=>validateSnapchatHandoff(value));
 const html=snapchatShareHtml('<script>alert("bad")</script>',null,'https://example.com/share');assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('access_token'));
});
const url=process.env.GROWTH_PUBLISH_TEST_DATABASE_URL;
test('Snapchat approved-content handoff integration without any provider request',{skip:!url},async t=>{
 const target=new URL(url!);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55481');assert.equal(target.pathname,'/growth_x_publish_test');
 const db=new Pool({connectionString:url,ssl:false});const original=global.fetch;let requests=0;global.fetch=async()=>{requests++;throw Error('No provider calls allowed');};
 process.env.GROWTH_SOCIAL_ENCRYPTION_KEY=Buffer.alloc(32,22).toString('base64');process.env.GROWTH_MEDIA_PUBLIC_ORIGIN='https://example.com';
 async function fixture(){
  const user=(await db.query("INSERT INTO data_room.users(email,role) VALUES($1,'founder_admin') RETURNING id",[`snap-${randomUUID()}@example.invalid`])).rows[0].id;
  const workspace=(await db.query("INSERT INTO growth_os.workspaces(owner_user_id,name) VALUES($1,'Snap test') RETURNING id",[user])).rows[0].id;
  const account=randomUUID();const connection=(await db.query("INSERT INTO growth_os.social_connections(workspace_id,provider,provider_account_id,provider_account_name,status,granted_scopes,last_successful_check_at,encrypted_access_token) VALUES($1,'snapchat',$2,'Founder','connected',$3,now(),$4) RETURNING id",[workspace,account,scopes,encryptSocialSecret('test-only-token')])).rows[0].id;
  const source=(await db.query("INSERT INTO growth_os.content_items(workspace_id,title,content_type) VALUES($1,'Snap draft','text') RETURNING id",[workspace])).rows[0].id;
  const variant=await upsertSocialContentVariant(workspace,source,'snapchat',{copy:'Approved Snapchat review content',media_references:[],destination_reference:account},db);
  const job=await createPublishJob(workspace,user,{connection_id:connection,content_variant_id:variant.id},db);const view=await getPublishJob(workspace,job.id,db);
  return {workspace,user,job:job.id,variant:variant.id,source,connection,account,fp:view.current_fingerprint};
 }
 async function approve(f:Awaited<ReturnType<typeof fixture>>){await approveSocialContentVariant(f.workspace,f.user,f.variant,{copy_approved:true,media_approved:true},db);await approvePublishJob(f.workspace,f.user,f.job,f.fp,db);}
 const input=(f:Awaited<ReturnType<typeof fixture>>)=>({confirmed:true,expected_fingerprint:f.fp});
 try{
 await t.test('draft and content approval alone cannot issue a page; explicit job approval and consent are required',async()=>{
  const f=await fixture();await assert.rejects(prepareHandoff(f.workspace,f.user,f.job,input(f),db));await approveSocialContentVariant(f.workspace,f.user,f.variant,{copy_approved:true,media_approved:true},db);await assert.rejects(prepareHandoff(f.workspace,f.user,f.job,input(f),db));await approve(f);await assert.rejects(prepareHandoff(f.workspace,f.user,f.job,{...input(f),confirmed:false},db));
 });
 await t.test('repeated concurrent requests return one handoff; final share stays unknown and no publishing occurs',async()=>{
  const f=await fixture();await approve(f);const [a,b]=await Promise.all([prepareHandoff(f.workspace,f.user,f.job,input(f),db),prepareHandoff(f.workspace,f.user,f.job,input(f),db)]);assert.equal(a.url,b.url);assert.equal(a.completion,'unknown');
  assert((await readHandoff(a.url.split('/').pop()!,db)).includes('Approved Snapchat review content'));
  const job=await getPublishJob(f.workspace,f.job,db);assert.equal(job.status,'approved');assert.equal(job.attempt_count,0);assert.equal(job.provider_post_id,null);
  await assert.rejects(executePublishJob(f.workspace,f.user,f.job,{confirm_publish:true,expected_fingerprint:f.fp},db),{code:'social_manual_handoff_required'});
  assert.equal((await db.query('SELECT count(*)::int n FROM growth_os.social_handoffs WHERE publish_job_id=$1',[f.job])).rows[0].n,1);
 });
 await t.test('invalid, expired, revoked, disconnected, changed account and edited content pages fail closed',async()=>{
  await assert.rejects(readHandoff('invalid',db));
  for(const mode of ['expired','revoked','disconnected','account','content','approval']){
   const f=await fixture();await approve(f);const h=await prepareHandoff(f.workspace,f.user,f.job,input(f),db);
   if(mode==='expired')await db.query("UPDATE growth_os.social_handoffs SET expires_at=now()-interval '1 second' WHERE publish_job_id=$1",[f.job]);
   if(mode==='revoked')await db.query('UPDATE growth_os.social_handoffs SET revoked_at=now() WHERE publish_job_id=$1',[f.job]);
   if(mode==='disconnected')await db.query("UPDATE growth_os.social_connections SET status='revoked',encrypted_access_token=NULL,encrypted_refresh_token=NULL WHERE id=$1",[f.connection]);
   if(mode==='account')await db.query("UPDATE growth_os.social_connections SET provider_account_id='changed' WHERE id=$1",[f.connection]);
   if(mode==='content')await upsertSocialContentVariant(f.workspace,f.source,'snapchat',{copy:'Edited',media_references:[],destination_reference:f.account},db);
   if(mode==='approval')await approveSocialContentVariant(f.workspace,f.user,f.variant,{copy_approved:false,media_approved:false},db);
   await assert.rejects(readHandoff(h.url.split('/').pop()!,db));
  }
 });
 await t.test('private media cannot be handed off; approved JPEG reuses revocable media delivery without storage-key exposure',async()=>{
  const f=await fixture();const source=(await db.query("INSERT INTO growth_os.media_assets(workspace_id,filename,display_name,asset_type,approved_for_use) VALUES($1,'approved.jpg','Approved image','image',true) RETURNING id",[f.workspace])).rows[0].id;
  const asset=(await db.query("INSERT INTO growth_os.publishing_assets(workspace_id,media_asset_id,object_key,sha256,mime_type,byte_size) VALUES($1,$2,$3,$4,'image/jpeg',10) RETURNING id",[f.workspace,source,'private/key/'+randomUUID(),'a'.repeat(64)])).rows[0].id;
  await upsertSocialContentVariant(f.workspace,f.source,'snapchat',{copy:'Image review',media_references:[{publishing_asset_id:asset}],destination_reference:f.account},db);
  f.fp=(await getPublishJob(f.workspace,f.job,db)).current_fingerprint;await approve(f);
  await assert.rejects(prepareHandoff(f.workspace,f.user,f.job,input(f),db));
  await db.query("UPDATE growth_os.publishing_assets SET state='approved',approved_by=$2,approved_at=now() WHERE id=$1",[asset,f.user]);
  const h=await prepareHandoff(f.workspace,f.user,f.job,input(f),db);const html=await readHandoff(h.url.split('/').pop()!,db);assert(html.includes('og:image'));assert(!html.includes('private/key'));assert(!html.includes(asset));
  assert.equal((await db.query('SELECT count(*)::int n FROM growth_os.media_deliveries WHERE publish_job_id=$1',[f.job])).rows[0].n,1);
  await db.query('UPDATE growth_os.media_assets SET approved_for_use=false WHERE id=$1',[source]);await assert.rejects(readHandoff(h.url.split('/').pop()!,db));
 });
 await t.test('workspace founder and matching current fingerprint are mandatory',async()=>{const f=await fixture();await approve(f);await assert.rejects(prepareHandoff(f.workspace,randomUUID(),f.job,input(f),db));await assert.rejects(prepareHandoff(f.workspace,f.user,f.job,{confirmed:true,expected_fingerprint:'stale'},db));await assert.rejects(prepareHandoff(randomUUID(),f.user,f.job,input(f),db));});
 assert.equal(requests,0);
 }finally{global.fetch=original;await db.end();}
});
