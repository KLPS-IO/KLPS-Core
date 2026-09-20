import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, retrieveDelivery, issueDelivery, deliveryOrigin, approvePublishingAsset, jpeg } from '../growth/media-delivery.service';
import { prepareInstagramRequest } from '../growth/social/meta.adapter';
const bytes=Buffer.from([255,216,255,224,0,2,255,217]);
const token='a'.repeat(64);
function db(rows:unknown[]) { const calls:any[]=[]; return {calls,query:async(sql:string,params:any[])=>{calls.push({sql,params});return {rows};}}; }
test('malformed delivery never reads database or storage',async()=>{
 const d=db([]); await assert.rejects(retrieveDelivery('../private',d as any,async()=>{throw Error('must not read');})); assert.equal(d.calls.length,0);
});
test('private, expired, revoked, missing deliveries fail closed without storage read',async()=>{
 const d=db([]); await assert.rejects(retrieveDelivery(token,d as any,async()=>{assert.fail('storage read');}));
 assert.match(d.calls[0].sql,/revoked_at IS NULL/); assert.match(d.calls[0].sql,/expires_at>now\(\)/); assert.match(d.calls[0].sql,/p.state='approved'/); assert.match(d.calls[0].sql,/m.approved_for_use=true/);
 assert.equal(d.calls[0].params[0],digest(token));
});
test('approved delivery verifies bytes and MIME and records retrieval',async()=>{
 const d=db([{id:'1',object_key:'private/key',sha256:digest(bytes),byte_size:bytes.length,mime_type:'image/jpeg'}]);
 assert.deepEqual(await retrieveDelivery(token,d as any,async()=>({body:bytes,contentType:'image/jpeg'})),bytes);
 assert.match(d.calls[1].sql,/last_retrieved_at/);
 for(const file of [{body:bytes,contentType:'text/html'},{body:Buffer.from('bad'),contentType:'image/jpeg'}]) await assert.rejects(retrieveDelivery(token,d as any,async()=>file));
});
test('issuance returns opaque HTTPS URL and safe provider state, never storage key',async()=>{
 process.env.GROWTH_MEDIA_PUBLIC_ORIGIN='https://media.example.com';
 const d=db([{id:'delivery',provider:'instagram',expires_at:'tomorrow'}]);
 const result=await issueDelivery('workspace','asset','instagram',d as any);
 assert.match(result.url,/^https:\/\/media.example.com\/api\/growth\/media-delivery\/[a-f0-9]{64}$/);
 assert.equal(result.state,'active'); assert.equal(result.provider,'instagram');
 assert.equal(JSON.stringify(result).includes('object_key'),false);
 assert.equal(d.calls[0].params[3],digest(result.url.split('/').pop()!));
 await assert.rejects(issueDelivery('w','a','unknown' as any,d as any));
 await assert.rejects(issueDelivery('w','a','instagram',db([]) as any));
});
test('approval requires existing asset approval and cannot reapprove revoked version',async()=>{
 const d=db([]); await assert.rejects(approvePublishingAsset('w','a','u',d as any));
 assert.match(d.calls[0].sql,/p.state='private'/); assert.match(d.calls[0].sql,/m.approved_for_use=true/);
});
test('origin and file validation fail safely',()=>{
 for(const origin of ['http://example.com','https://user:pass@example.com','https://example.com/path']) {process.env.GROWTH_MEDIA_PUBLIC_ORIGIN=origin;assert.throws(deliveryOrigin);}
 assert.equal(jpeg(Buffer.from('<svg/>')),false); assert.equal(jpeg(Buffer.alloc(8388609)),false);
});
test('Meta preparation separates login scopes, stages and explicit approval without network',()=>{
 const base={loginMode:'instagram' as const,userId:'17841466528859006',accessToken:'secret',approved:true};
 const create=prepareInstagramRequest({...base,stage:'container',imageUrl:'https://media.example.com/image',caption:'KLPS test'});
 assert.match(create.url,/graph.instagram.com.*\/media$/);assert.equal(create.requiredPermission,'instagram_business_content_publish');
 assert.equal(create.init.body.get('image_url'),'https://media.example.com/image'); assert.equal(create.url.includes('secret'),false);
 const publish=prepareInstagramRequest({...base,loginMode:'facebook',stage:'publish',creationId:'123'});
 assert.match(publish.url,/graph.facebook.com.*\/media_publish$/);assert.equal(publish.init.body.get('creation_id'),'123');
 assert.throws(()=>prepareInstagramRequest({...base,approved:false,stage:'publish',creationId:'123'}));
});
