import { Pool, PoolClient } from 'pg';
import { pool } from '../../storage/postgres.client';
import { getSocialAdapter } from './social.registry';
import { auditSocialEvent, approvalMustReset, validatePublishReadiness } from './social.service';
import { decryptSocialSecret, encryptSocialSecret, fingerprintSocialContent } from './social.crypto';
import { SocialPublishError } from './social.publish-error';

type Database = Pick<Pool,'connect'|'query'>;
const error = (code: string, message: string, statusCode=409) => Object.assign(new Error(message),{code,statusCode});
const id = (value: string) => {if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))throw error('social_invalid_id','Invalid publish job.',400);return value;};
const selection = `SELECT j.*,c.provider,c.provider_account_id,c.provider_account_name,c.status AS connection_status,
 c.encrypted_access_token,c.encrypted_refresh_token,c.token_expires_at,c.granted_scopes,c.last_successful_check_at,
 v.copy,v.media_references,v.destination_reference,v.copy_approved_at,v.media_approved_at,v.approved_by AS variant_approved_by,
 v.approval_fingerprint AS variant_fingerprint
 FROM growth_os.social_publish_jobs j
 JOIN growth_os.social_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
 JOIN growth_os.social_content_variants v ON v.id=j.content_variant_id AND v.workspace_id=j.workspace_id AND v.provider=c.provider
 WHERE j.workspace_id=$1 AND j.id=$2`;
const content = (row: Record<string,any>) => ({copy:row.copy,media:row.media_references,destination:row.destination_reference});
const publicJob = (row: Record<string,any>) => ({
 id:row.id,provider:row.provider,status:row.status,content_variant_id:row.content_variant_id,
 copy:row.execution_copy ?? row.copy,account_name:row.provider_account_name,
 ...(row.provider==='snapchat'?{media_references:row.media_references}:{}),
 destination_reference:row.destination_reference,current_fingerprint:fingerprintSocialContent(content(row)),
 approval_fingerprint:row.approval_fingerprint,approved_account_id:row.approved_account_id,
 provider_post_id:row.provider_post_id,provider_post_url:row.provider_post_url,published_at:row.published_at,
 execution_state:row.execution_state,attempt_count:row.attempt_count,last_error_code:row.last_error_code,retry_after:row.retry_after,
 needs_review:row.execution_state==='unknown'||row.execution_state==='in_flight'
});
async function transaction<T>(db:Database,work:(c:PoolClient)=>Promise<T>) {
 const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
export async function founder(c:PoolClient,workspace:string,user:string) {
 const r=await c.query(`SELECT w.id FROM growth_os.workspaces w JOIN data_room.users u ON u.id=w.owner_user_id
 WHERE w.id=$1 AND u.id=$2 AND u.role='founder_admin' AND coalesce(u.is_active,true) AND (u.expires_at IS NULL OR u.expires_at>now())`,[workspace,user]);
 if(!r.rows.length)throw error('social_founder_required','Only the workspace founder can approve or publish.',403);
}
export async function locked(c:PoolClient,workspace:string,job:string) {
 const r=await c.query(selection+' FOR UPDATE OF c,v,j',[workspace,id(job)]);
 if(!r.rows[0])throw error('social_publish_job_not_found','Publish job not found.',404);return r.rows[0];
}
export function validate(row:Record<string,any>,expected:string) {
 const adapter=getSocialAdapter(row.provider);
 if(!adapter.validatePublish || !adapter.capabilitiesForScopes)throw error('social_provider_not_activated','Publishing for this provider is not enabled.');
 if(expected!==fingerprintSocialContent(content(row)))throw error('social_approval_stale','Content or destination changed. Review and approve it again.');
 const readiness=validatePublishReadiness({
  copyApproved:Boolean(row.copy_approved_at&&row.variant_approved_by)&&!approvalMustReset(row.variant_fingerprint,content(row)),
  mediaApproved:Boolean(row.media_approved_at)&&!approvalMustReset(row.variant_fingerprint,content(row)),
  destinationValid:Boolean(row.provider_account_id)&&row.destination_reference===row.provider_account_id,
  connected:row.connection_status==='connected',healthy:Boolean(row.last_successful_check_at),
  requiredCapabilities:adapter.approvalCapabilities ?? ['text','direct_publishing'],availableCapabilities:adapter.capabilitiesForScopes(row.granted_scopes ?? [])
 });
 if(!readiness.ready)throw error('social_publish_not_ready',`Publishing is blocked: ${readiness.missing.join(', ')}. Reconnect if write access is missing.`);
 adapter.validatePublish({text:row.copy,media:row.media_references});return adapter;
}
export async function getPublishJob(workspace:string,job:string,db:Database=pool) {
 const r=await db.query(selection,[workspace,id(job)]);if(!r.rows[0])throw error('social_publish_job_not_found','Publish job not found.',404);return publicJob(r.rows[0]);
}
export async function listPublishJobs(workspace:string,db:Database=pool) {
 const r=await db.query(selection.replace(' AND j.id=$2','')+' ORDER BY j.created_at DESC LIMIT 100',[workspace]);return r.rows.map(publicJob);
}
export async function approvePublishJob(workspace:string,user:string,job:string,expected:string,db:Database=pool) {
 return transaction(db,async c=>{
  await founder(c,workspace,user);const row=await locked(c,workspace,job);validate(row,expected);
  if(!['draft','approved'].includes(row.status)||row.execution_state!=='not_started')throw error('social_job_state_invalid','This job cannot be approved again.');
  const r=await c.query(`UPDATE growth_os.social_publish_jobs SET status='approved',approved_at=now(),approved_by=$3,
   approval_fingerprint=$4,approved_account_id=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *`,[workspace,job,user,expected,row.provider_account_id]);
  await auditSocialEvent(workspace,user,row.provider,'publish_job_approved','success',{publish_job_id:job},c);
  return publicJob({...row,...r.rows[0]});
 });
}

// Refresh is serialized by the connection row lock, and both rotated tokens are committed together.
async function freshToken(workspace:string,user:string,job:string,expected:string,db:Database) {
 return transaction(db,async c=>{
  await founder(c,workspace,user);const row=await locked(c,workspace,job);const adapter=validate(row,expected);
  if(row.status==='published'||row.execution_state==='in_flight'||row.execution_state==='unknown')return;
  if(!['approved','retry','scheduled'].includes(row.status)||!row.approved_at||row.approval_fingerprint!==expected||row.approved_account_id!==row.provider_account_id)
   throw error('social_job_not_approved','Approve this publish job for its current content and account first.');
  if(row.token_expires_at && Date.parse(row.token_expires_at)>Date.now()+60000)return;
  try {
   if(!row.encrypted_refresh_token)throw new Error('Missing refresh grant');
   const token=await adapter.refreshToken(decryptSocialSecret(row.encrypted_refresh_token));
   const scopes=token.scopes ?? row.granted_scopes;
   await c.query(`UPDATE growth_os.social_connections SET encrypted_access_token=$3,encrypted_refresh_token=$4,
    token_expires_at=$5,granted_scopes=$6,discovered_capabilities=$7,last_successful_check_at=now(),last_error_code=NULL,last_error_at=NULL
    WHERE workspace_id=$1 AND id=$2`,[workspace,row.connection_id,encryptSocialSecret(token.accessToken),token.refreshToken?encryptSocialSecret(token.refreshToken):row.encrypted_refresh_token,token.expiresAt,scopes,adapter.capabilitiesForScopes!(scopes)]);
   await auditSocialEvent(workspace,user,row.provider,'credential_refresh','success',{connection_id:row.connection_id},c);
  } catch {
   await c.query(`UPDATE growth_os.social_connections SET status='expired',last_error_code='social_reauthorization_required',last_error_at=now() WHERE workspace_id=$1 AND id=$2`,[workspace,row.connection_id]);
   await auditSocialEvent(workspace,user,row.provider,'credential_refresh','failure',{connection_id:row.connection_id,reason:'reauthorization_required'},c);
  }
 });
}

export async function executePublishJob(workspace:string,user:string,job:string,input:{confirm_publish?:boolean;expected_fingerprint?:string},db:Database=pool) {
 if(input.confirm_publish!==true||typeof input.expected_fingerprint!=='string')throw error('social_publish_confirmation_required','Explicit founder confirmation of the approved post is required.',400);
 const expected=input.expected_fingerprint;
 // Idempotent replay of a confirmed result needs no token refresh or new provider request.
 const existing=await getPublishJob(workspace,job,db);
 if(getSocialAdapter(existing.provider).manualHandoff)throw error('social_manual_handoff_required','Complete this share manually in Snapchat; direct publishing is unavailable.');
 if(existing.status==='published')return existing;
 await freshToken(workspace,user,job,expected,db);
 let claim;
 try {claim=await transaction(db,async c=>{
  await founder(c,workspace,user);const row=await locked(c,workspace,job);
  if(row.status==='published')return {already:publicJob(row)};
  const adapter=validate(row,expected);
  if(row.execution_state==='in_flight'||row.execution_state==='unknown')throw error('social_publish_outcome_unknown','This job may already have reached X. It will not be resent; check the provider.');
  if(!['approved','retry','scheduled'].includes(row.status)||!row.approved_at||!row.approved_by||row.approval_fingerprint!==expected||row.approved_account_id!==row.provider_account_id)
   throw error('social_job_not_approved','This publish job requires current founder approval.');
  if(row.status==='scheduled'&&Date.parse(row.scheduled_for)>Date.now())throw error('social_job_not_due','The approved schedule has not arrived.');
  if(row.retry_after&&Date.parse(row.retry_after)>Date.now())throw error('social_retry_not_due','The provider cooldown has not ended.');
  if(row.attempt_count>=3)throw error('social_retry_limit','Retry limit reached. Review the provider outcome.');
  if(!row.token_expires_at||Date.parse(row.token_expires_at)<=Date.now())throw error('social_reauthorization_required','Reconnect before publishing.');
  const key=fingerprintSocialContent({provider:row.provider,account:row.provider_account_id,text:row.copy});
  await c.query(`UPDATE growth_os.social_publish_jobs SET status='publishing',execution_state='in_flight',deduplication_key=$3,
   execution_copy=$4,attempt_count=attempt_count+1,last_error_code=NULL,last_error_at=NULL,retry_after=NULL WHERE workspace_id=$1 AND id=$2`,[workspace,job,key,row.copy]);
  await auditSocialEvent(workspace,user,row.provider,'publish_execution','started',{publish_job_id:job},c);
  return {adapter,accessToken:decryptSocialSecret(row.encrypted_access_token),text:row.copy,media:row.media_references,provider:row.provider,connection:row.connection_id,encryptedToken:row.encrypted_access_token};
 });}catch(e){if((e as {code?:string}).code==='23505')throw error('social_duplicate_publish','This account already has a publishing attempt for this text. Open the existing job.');throw e;}
 if('already' in claim)return claim.already!;
 // The durable in-flight marker is committed BEFORE the external side effect.
 // Never wrap this POST in a retry or a transaction which could roll back the marker.
 let outcome;
 try{outcome=await claim.adapter.publish(claim.accessToken,{text:claim.text,media:claim.media});}
 catch(reason){
  const failure=reason instanceof SocialPublishError ? reason : new SocialPublishError('social_publish_outcome_unknown','Provider outcome is unconfirmed.','unknown');
  await transaction(db,async c=>{
   await c.query(`UPDATE growth_os.social_publish_jobs SET status=$3,execution_state=$4,last_error_code=$5,last_error_at=now(),retry_after=$6,last_provider_http_status=$7
    WHERE workspace_id=$1 AND id=$2 AND execution_state='in_flight'`,[workspace,job,failure.outcome==='rejected'&&failure.retryAfter?'retry':'failed',failure.outcome,failure.code,failure.retryAfter,failure.providerHttpStatus]);
   if(failure.reauthorize)await c.query(`UPDATE growth_os.social_connections SET status='expired',last_error_code='social_reauthorization_required',last_error_at=now() WHERE workspace_id=$1 AND id=$2 AND encrypted_access_token=$3`,[workspace,claim.connection,claim.encryptedToken]);
   await auditSocialEvent(workspace,user,claim.provider,'publish_execution','failure',{publish_job_id:job,reason:failure.code,outcome:failure.outcome},c);
  });
  return getPublishJob(workspace,job,db);
 }
 // A failure to persist success leaves in_flight intact; another request cannot replay the POST.
 await transaction(db,async c=>{
  await c.query(`UPDATE growth_os.social_publish_jobs SET status='published',execution_state='succeeded',provider_post_id=$3,provider_post_url=$4,published_at=now(),last_error_code=NULL,last_error_at=NULL,last_provider_http_status=201
   WHERE workspace_id=$1 AND id=$2 AND execution_state='in_flight'`,[workspace,job,outcome.postId,outcome.postUrl]);
  await auditSocialEvent(workspace,user,claim.provider,'publish_execution','success',{publish_job_id:job,provider_post_id:outcome.postId},c);
 });
 return getPublishJob(workspace,job,db);
}
