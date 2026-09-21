import test from 'node:test';
import assert from 'node:assert/strict';
import { xPublishingCapabilities, validateXTextPost, publishXText, refreshXAccessToken } from '../growth/social/x.adapter';
import { getSocialAdapter } from '../growth/social/social.registry';
import { getSocialProviderOverview } from '../growth/social/social.service';
import { SocialPublishError } from '../growth/social/social.publish-error';

test('only the actual write grant enables X; read-only and partial grants remain identity-only',()=>{
 assert.deepEqual(xPublishingCapabilities(['tweet.read','users.read','offline.access']),[]);
 assert.deepEqual(xPublishingCapabilities(['tweet.write']),[]);
 assert.deepEqual(xPublishingCapabilities(['tweet.read','users.read','tweet.write']),['text','direct_publishing']);
});
test('overview never promotes an existing read-only connection from configured requested scopes',async()=>{
 const rows=[{id:'c',provider:'x',status:'connected',granted_scopes:['tweet.read','users.read','offline.access'],discovered_capabilities:['text','direct_publishing']}];
 const db={query:async(sql:string)=>({rows:sql.includes('FROM growth_os.social_connections')?rows:[]})};
 let x=(await getSocialProviderOverview('w',db as never)).find(p=>p.provider==='x')!;
 assert.equal(x.publishing_enabled,false);assert.equal(x.reauthorization_required,true);assert.deepEqual(x.capabilities,[]);assert(x.required_permissions.includes('tweet.write'));
 rows[0].granted_scopes.push('tweet.write');
 x=(await getSocialProviderOverview('w',db as never)).find(p=>p.provider==='x')!;assert.equal(x.publishing_enabled,true);
 rows[0].status='expired';x=(await getSocialProviderOverview('w',db as never)).find(p=>p.provider==='x')!;assert.equal(x.publishing_enabled,false);assert.deepEqual(x.capabilities,[]);assert.deepEqual(x.connection?.discovered_capabilities,[]);
});
test('text validation uses X weighted Unicode and URL rules; attachments stay gated',()=>{
 validateXTextPost({text:'a'.repeat(280),media:[]});validateXTextPost({text:'😀'.repeat(140),media:[]});
 validateXTextPost({text:'https://example.com/'+ 'a'.repeat(400),media:[]});
 for(const input of [{text:' ',media:[]},{text:'a'.repeat(281),media:[]},{text:'😀'.repeat(141),media:[]},{text:'hi',media:[{type:'image'}]}])assert.throws(()=>validateXTextPost(input));
});
test('X post execution sends only text and bearer authentication and returns canonical provider result',async()=>{
 const original=global.fetch;let count=0;
 global.fetch=async(url,init)=>{count++;assert.equal(url,'https://api.x.com/2/tweets');assert.equal(init?.method,'POST');assert.equal((init?.headers as any).Authorization,'Bearer secret');assert.deepEqual(JSON.parse(String(init?.body)),{text:'Approved text'});return new Response(JSON.stringify({data:{id:'1234',text:'Approved text'}}),{status:201});};
 try{assert.deepEqual(await publishXText('secret',{text:'Approved text',media:[]}),{postId:'1234',postUrl:'https://x.com/i/web/status/1234'});assert.equal(count,1);}finally{global.fetch=original;}
});
test('provider failures are sanitized; ambiguous results are never marked retryable',async()=>{
 const original=global.fetch;try{
 for(const status of [400,401,402,403,429,500,503,200]){
 global.fetch=async()=>new Response(JSON.stringify({message:'leaked access-token refresh-token',data:{id:null}}),{status});
 await assert.rejects(publishXText('secret',{text:'Valid',media:[]}),e=>{assert(e instanceof SocialPublishError);assert(!e.message.includes('leaked'));assert(!JSON.stringify(e).includes('access-token'));assert.equal(e.outcome,status>=500||status===200?'unknown':'rejected');if(status===429)assert(e.retryAfter);return true;});
 }
 global.fetch=async()=>{throw Error('raw secret transport failure');};await assert.rejects(publishXText('secret',{text:'Valid',media:[]}),e=>e instanceof SocialPublishError&&e.outcome==='unknown'&&!e.message.includes('secret'));
 }finally{global.fetch=original;}
});
test('refresh retains omitted scopes, supports rotation, and never requests additional scopes',async()=>{
 const original=global.fetch;const definition=getSocialAdapter('x').definition;try{
 global.fetch=async(url,init)=>{assert.equal(url,'https://api.x.com/2/oauth2/token');const body=init?.body as URLSearchParams;assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'old-refresh');assert.equal(body.has('scope'),false);return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:7200}),{status:200});};
 const token=await refreshXAccessToken(definition,{clientId:'id',clientSecret:'secret'},'old-refresh');assert.equal(token.refreshToken,'new-refresh');assert.equal(token.scopes,undefined);
 global.fetch=async()=>new Response(JSON.stringify({access_token:'new',expires_in:7200,scope:'tweet.read users.read'}),{status:200});assert.deepEqual((await refreshXAccessToken(definition,{clientId:'id',clientSecret:'secret'},'old')).scopes,['tweet.read','users.read']);
 global.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant',secret:'raw'}),{status:400});await assert.rejects(refreshXAccessToken(definition,{clientId:'id',clientSecret:'secret'},'old'),e=>e instanceof SocialPublishError&&e.reauthorize&&!JSON.stringify(e).includes('raw'));
 }finally{global.fetch=original;}
});
