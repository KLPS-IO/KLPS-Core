// Disposable database only; never reads DATABASE_URL or R2 configuration.
const {Pool}=require('pg');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const db=new Pool({host:'127.0.0.1',port:55479,database:'growth_media_delivery_test',ssl:false});
const media=require('../dist/server/src/growth/media-delivery.service');
(async()=>{
 await db.query(`CREATE SCHEMA data_room; CREATE TABLE data_room.users(id uuid PRIMARY KEY);
 CREATE SCHEMA growth_os; CREATE TABLE growth_os.media_assets(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,approved_for_use boolean DEFAULT false);
 CREATE TABLE growth_os.social_content_variants(id uuid,workspace_id uuid,provider text);
 CREATE TABLE growth_os.social_publish_jobs(id uuid,workspace_id uuid,content_variant_id uuid, UNIQUE(workspace_id,id));`);
 await db.query(fs.readFileSync('server/sql/20260920_growth_media_delivery.sql','utf8'));
 const w='00000000-0000-4000-8000-000000000001',a='00000000-0000-4000-8000-000000000002',u='00000000-0000-4000-8000-000000000003';
 await db.query('INSERT INTO data_room.users VALUES($1)',[u]);
 await db.query('INSERT INTO growth_os.media_assets VALUES($1,$2,false)',[a,w]);
 const bytes=fs.readFileSync('server/fixtures/klps-social-review.jpg');
 const p=(await db.query(`INSERT INTO growth_os.publishing_assets(workspace_id,media_asset_id,object_key,sha256,mime_type,byte_size) VALUES($1,$2,'private-key',$3,'image/jpeg',$4) RETURNING id`,[w,a,media.digest(bytes),bytes.length])).rows[0].id;
 process.env.GROWTH_MEDIA_PUBLIC_ORIGIN='https://media.example.com';
 await assert.rejects(media.issueDelivery(w,p,'instagram',db));
 await assert.rejects(media.approvePublishingAsset(w,p,u,db));
 await db.query('UPDATE growth_os.media_assets SET approved_for_use=true');
 await media.approvePublishingAsset(w,p,u,db);
 const delivery=await media.issueDelivery(w,p,'instagram',db);
 const token=delivery.url.split('/').pop();
 const read=async()=>({body:bytes,contentType:'image/jpeg'});
 assert.deepEqual(await media.retrieveDelivery(token,db,read),bytes);
 const storage=require('../dist/server/src/services/r2.service'); storage.readFromR2=read;
 require('../dist/server/src/storage/postgres.client').pool.query=db.query.bind(db);
 const express=require('express'), app=express();
 app.use('/api/growth',require('../dist/server/src/growth/media-delivery.routes').publicMediaRoutes);
 const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
 try {
 const base=`http://127.0.0.1:${server.address().port}/api/growth/media-delivery/`;
 const response=await fetch(base+token); assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/^image\/jpeg/);
 assert.match(response.headers.get('cache-control'),/no-store/);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 assert.equal((await fetch(base+'private-key')).status,404);
 assert.equal((await fetch(base+'f'.repeat(64))).status,404);
 assert.equal((await fetch(base+token,{method:'HEAD'})).status,200);
 } finally { await new Promise(resolve=>server.close(resolve)); }

 assert.equal((await media.deliveryStates(w,p,db))[0].state,'active');
 await assert.rejects(media.retrieveDelivery(token,db,async()=>({body:bytes,contentType:'text/html'})));
 await db.query("UPDATE growth_os.media_deliveries SET expires_at=now()-interval '1 second'");
 await assert.rejects(media.retrieveDelivery(token,db,read));
 assert.equal((await media.deliveryStates(w,p,db))[0].state,'expired');
 const second=await media.issueDelivery(w,p,'instagram',db);
 await media.revokeDelivery(w,second.id,db);
 await assert.rejects(media.retrieveDelivery(second.url.split('/').pop(),db,read));
 const third=await media.issueDelivery(w,p,'instagram',db);
 await db.query('UPDATE growth_os.media_assets SET approved_for_use=false');
 await db.query('UPDATE growth_os.media_assets SET approved_for_use=true');
 await assert.rejects(media.retrieveDelivery(third.url.split('/').pop(),db,read));
 await assert.rejects(media.approvePublishingAsset(w,p,u,db));
 await assert.rejects(db.query("UPDATE growth_os.publishing_assets SET object_key='stolen-key'"));
 await assert.rejects(media.issueDelivery(u,p,'instagram',db));
 console.log('PASS: migration, private denial, approval, bytes/MIME, expiry, revocation, permanent withdrawal, immutable keys, workspace isolation, provider state');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.end());
