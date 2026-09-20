import { createHash, randomBytes, randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { uploadToR2, readFromR2, deleteFromR2 } from '../services/r2.service';
import { SOCIAL_PROVIDERS, SocialProvider } from './social/social.types';
type Db = Pick<PoolClient, 'query'>;
const fail = (statusCode=400) => Object.assign(new Error('Media delivery unavailable'), {statusCode,code:'media_delivery_unavailable'});
export const digest = (bytes: Buffer|string) => createHash('sha256').update(bytes).digest('hex');
export const jpeg = (bytes: Buffer) => bytes.length > 4 && bytes.length <= 8388608 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217;
export function deliveryOrigin() {
 const url = new URL(process.env.GROWTH_MEDIA_PUBLIC_ORIGIN ?? '');
 if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw fail(503);
 return url.origin;
}
// Upload bytes, never accept a caller-selected object key or remote URL.
export async function uploadPublishingAsset(workspace:string, asset:string, bytes:Buffer, db:Db=pool) {
 if(!jpeg(bytes)) throw fail();
 const found=await db.query('SELECT id FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2',[workspace,asset]);
 if(!found.rows.length) throw fail(404);
 const key=`growth-social/${workspace}/${randomUUID()}.jpg`;
 await uploadToR2(key,bytes,'image/jpeg');
 try {
 const result=await db.query(`INSERT INTO growth_os.publishing_assets(workspace_id,media_asset_id,object_key,sha256,mime_type,byte_size)
 VALUES($1,$2,$3,$4,'image/jpeg',$5) RETURNING id,state,mime_type,byte_size`,[workspace,asset,key,digest(bytes),bytes.length]);
 return result.rows[0];
 } catch(error) { await deleteFromR2(key).catch(()=>undefined); throw error; }
}
export async function approvePublishingAsset(workspace:string,id:string,user:string,db:Db=pool) {
 const result=await db.query(`UPDATE growth_os.publishing_assets p SET state='approved',approved_by=$3,approved_at=now()
 FROM growth_os.media_assets m WHERE p.workspace_id=$1 AND p.id=$2 AND p.state='private'
 AND m.workspace_id=p.workspace_id AND m.id=p.media_asset_id AND m.approved_for_use=true
 RETURNING p.id,p.state,p.approved_at`,[workspace,id,user]);
 if(!result.rows.length) throw fail(409);
 return result.rows[0];
}
export async function issueDelivery(workspace:string,id:string,provider:SocialProvider,db:Db=pool,publishJobId:string|null=null) {
 if(!SOCIAL_PROVIDERS.includes(provider)) throw fail();
 const origin=deliveryOrigin(), token=randomBytes(32).toString('hex');
 const result=await db.query(`INSERT INTO growth_os.media_deliveries(workspace_id,publishing_asset_id,provider,token_hash,expires_at,publish_job_id)
 SELECT p.workspace_id,p.id,$3,$4,now()+interval '72 hours',$5::uuid FROM growth_os.publishing_assets p
 JOIN growth_os.media_assets m ON m.id=p.media_asset_id AND m.workspace_id=p.workspace_id
 WHERE p.workspace_id=$1 AND p.id=$2 AND p.state='approved' AND m.approved_for_use=true
 AND ($5::uuid IS NULL OR EXISTS (
 SELECT 1 FROM growth_os.social_publish_jobs j JOIN growth_os.social_content_variants v
 ON v.id=j.content_variant_id AND v.workspace_id=j.workspace_id
 WHERE j.workspace_id=p.workspace_id AND j.id=$5::uuid AND v.provider=$3))
 RETURNING id,provider,expires_at,publish_job_id`,[workspace,id,provider,digest(token),publishJobId]);
 if(!result.rows.length) throw fail(409);
 return {...result.rows[0],url:`${origin}/api/growth/media-delivery/${token}`,state:'active'};
}
export async function retrieveDelivery(token:string,db:Db=pool,read=readFromR2) {
 if(!/^[a-f0-9]{64}$/.test(token)) throw fail(404);
 const result=await db.query(`SELECT d.id,p.object_key,p.sha256,p.byte_size,p.mime_type FROM growth_os.media_deliveries d
 JOIN growth_os.publishing_assets p ON p.id=d.publishing_asset_id AND p.workspace_id=d.workspace_id
 JOIN growth_os.media_assets m ON m.id=p.media_asset_id AND m.workspace_id=p.workspace_id
 WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>now() AND p.state='approved' AND m.approved_for_use=true`,[digest(token)]);
 const record=result.rows[0]; if(!record) throw fail(404);
 const file=await read(record.object_key);
 if(file.contentType!=='image/jpeg' || record.mime_type!=='image/jpeg' || file.body.length!==record.byte_size || !jpeg(file.body) || digest(file.body)!==record.sha256) throw fail(404);
 await db.query('UPDATE growth_os.media_deliveries SET last_retrieved_at=now() WHERE id=$1',[record.id]);
 return file.body;
}
export async function revokeDelivery(workspace:string,id:string,db:Db=pool) {
 const result=await db.query(`UPDATE growth_os.media_deliveries SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1 AND id=$2 RETURNING id,revoked_at`,[workspace,id]);
 if(!result.rows.length) throw fail(404); return result.rows[0];
}
export async function deliveryStates(workspace:string,id:string,db:Db=pool) {
 const result=await db.query(`SELECT d.id,d.provider,d.expires_at,d.last_retrieved_at,d.publish_job_id,
 CASE WHEN d.revoked_at IS NOT NULL OR p.state<>'approved' OR NOT m.approved_for_use THEN 'revoked'
 WHEN d.expires_at<=now() THEN 'expired' ELSE 'active' END AS state
 FROM growth_os.media_deliveries d JOIN growth_os.publishing_assets p ON p.id=d.publishing_asset_id
 JOIN growth_os.media_assets m ON m.id=p.media_asset_id WHERE d.workspace_id=$1 AND d.publishing_asset_id=$2`,[workspace,id]); return result.rows;
}
