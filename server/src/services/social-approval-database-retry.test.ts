/// <reference lib="es2021.promise" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pool } from '../storage/postgres.client';
import { approveSocialContentVariant } from '../growth/social/social.service';

const workspace='10000000-0000-4000-8000-000000000001';
const founder='10000000-0000-4000-8000-000000000002';
const variantId='10000000-0000-4000-8000-000000000003';
const timeout=()=>Object.assign(new AggregateError([Object.assign(new Error('connect timeout'),{code:'ETIMEDOUT'})],''),{code:'ETIMEDOUT'});

test('production regression: empty-message AggregateError ETIMEDOUT during approval reconnects without publishing',async()=>{
 const originalConnect=pool.connect,originalFetch=global.fetch;
 let acquisitions=0,providerRequests=0;const queries:string[]=[];
 const variant={id:variantId,workspace_id:workspace,provider:'x',copy:'KLPS Growth OS publishing test.',media_references:[],destination_reference:'1234'};
 // Exercise the actual pg-pool query wrapper used in production, not an injected Db bypassing it.
 pool.connect=((callback:any)=>{
  acquisitions++;
  if(acquisitions===1){callback(timeout());return;}
  const client=Object.assign(new EventEmitter(),{release:()=>undefined,query:(sql:string,values:unknown[],done:any)=>{
   queries.push(sql);
   done(null,{rows:sql.includes('social_content_variants')?[{...variant,approved_by:sql.includes('UPDATE')?founder:null}]:[]});
  }});
  callback(null,client);
 }) as typeof pool.connect;
 global.fetch=async()=>{providerRequests++;throw Error('Approval must not contact any social provider');};
 try{
  assert.equal(timeout().message,'');
  const result=await approveSocialContentVariant(workspace,founder,variantId,{copy_approved:true,media_approved:true});
  assert.equal(result.approved_by,founder);assert.equal(acquisitions,4);
  assert.equal(queries.filter(sql=>sql.includes('UPDATE growth_os.social_content_variants')).length,1);
  assert.equal(queries.filter(sql=>sql.includes('INSERT INTO growth_os.social_audit_events')).length,1);
  assert(!queries.some(sql=>sql.includes('social_publish_jobs')));assert.equal(providerRequests,0);
 }finally{pool.connect=originalConnect;global.fetch=originalFetch;}
});

test('approval does not retry schema, constraint, authorization or unknown failures',async()=>{
 const originalConnect=pool.connect;
 try{for(const code of ['42703','23514','42501','UNKNOWN']){
  let acquisitions=0;const failure=Object.assign(new Error(''),{code});
  pool.connect=((callback:any)=>{acquisitions++;callback(failure);}) as typeof pool.connect;
  await assert.rejects(approveSocialContentVariant(workspace,founder,variantId,{copy_approved:true,media_approved:true}),e=>e===failure);
  assert.equal(acquisitions,1);
 }}finally{pool.connect=originalConnect;}
});

test('persistent coded timeout remains bounded and never writes an approval',async()=>{
 const originalConnect=pool.connect;let acquisitions=0;
 pool.connect=((callback:any)=>{acquisitions++;callback(timeout());}) as typeof pool.connect;
 try{await assert.rejects(approveSocialContentVariant(workspace,founder,variantId,{copy_approved:true,media_approved:true}),{code:'ETIMEDOUT'});assert.equal(acquisitions,8);}
 finally{pool.connect=originalConnect;}
});
