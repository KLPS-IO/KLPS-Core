import {readFromR2} from '../../services/r2.service';
import {jpeg} from '../media-delivery.service';
import {randomBytes} from 'crypto';
import {Pool} from 'pg';
import {pool} from '../../storage/postgres.client';
import {founder,locked,validate} from './social-publishing.service';
import {auditSocialEvent} from './social.service';
import {encryptSocialSecret,decryptSocialSecret,fingerprintSocialContent} from './social.crypto';
import {deliveryOrigin,digest,issueDelivery} from '../media-delivery.service';
import {snapchatShareHtml} from './snapchat-handoff.adapter';
type Database=Pick<Pool,'query'|'connect'>;
const unavailable=()=>Object.assign(new Error('Handoff unavailable. Review the content, account and approvals again.'),{statusCode:409,code:'social_handoff_unavailable'});
export async function eligibleHandoffMedia(workspace:string,db:Pick<Pool,'query'>=pool){
 return (await db.query(`SELECT p.id,p.media_asset_id,m.display_name,m.filename FROM growth_os.publishing_assets p JOIN growth_os.media_assets m ON m.id=p.media_asset_id AND m.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.state='approved' AND m.approved_for_use=true AND p.mime_type='image/jpeg' ORDER BY p.created_at DESC LIMIT 100`,[workspace])).rows;
}
export async function previewHandoffMedia(workspace:string,id:string){
 const row=(await pool.query(`SELECT p.object_key,p.sha256 FROM growth_os.publishing_assets p JOIN growth_os.media_assets m ON m.id=p.media_asset_id AND m.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=$2 AND p.state='approved' AND m.approved_for_use=true AND p.mime_type='image/jpeg'`,[workspace,id])).rows[0];
 if(!row)throw unavailable();const file=await readFromR2(row.object_key);if(!jpeg(file.body)||digest(file.body)!==row.sha256)throw unavailable();return file.body;
}
// Creates a retrievable approved-content page, never a provider publication.
export async function prepareHandoff(workspace:string,user:string,job:string,input:{confirmed?:boolean;expected_fingerprint?:string},db:Database=pool){
 if(input.confirmed!==true||typeof input.expected_fingerprint!=='string')throw unavailable();
 const c=await db.connect();try{
 await c.query('BEGIN');await founder(c,workspace,user);const row=await locked(c,workspace,job);
 if(row.provider!=='snapchat')throw unavailable();validate(row,input.expected_fingerprint);
 if(row.status!=='approved'||row.execution_state!=='not_started'||!row.approved_by||!row.approved_at||row.approval_fingerprint!==input.expected_fingerprint||row.approved_account_id!==row.provider_account_id)throw unavailable();
 const existing=(await c.query('SELECT * FROM growth_os.social_handoffs WHERE workspace_id=$1 AND publish_job_id=$2 FOR UPDATE',[workspace,job])).rows[0];
 if(existing){if(existing.revoked_at||new Date(existing.expires_at).getTime()<=Date.now())throw unavailable();await c.query('COMMIT');return {url:decryptSocialSecret(existing.encrypted_url),expires_at:existing.expires_at,state:'handoff_ready',completion:'unknown'};}
 let imageUrl:string|null=null,deliveryId:string|null=null;
 if(row.media_references.length){const asset=row.media_references[0].publishing_asset_id;
 const assetRow=(await c.query(`SELECT p.id FROM growth_os.publishing_assets p JOIN growth_os.media_assets m ON m.id=p.media_asset_id AND m.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=$2 AND p.state='approved' AND m.approved_for_use=true AND p.mime_type='image/jpeg' FOR SHARE OF p,m`,[workspace,asset])).rows[0];if(!assetRow)throw unavailable();
 const delivery=await issueDelivery(workspace,asset,'snapchat',c,job);imageUrl=delivery.url;deliveryId=delivery.id;
 }
 const token=randomBytes(32).toString('hex'),url=`${deliveryOrigin()}/api/growth/social/handoffs/${token}`;
 const result=(await c.query(`INSERT INTO growth_os.social_handoffs(workspace_id,publish_job_id,provider,token_hash,encrypted_url,image_url,media_delivery_id,expires_at) VALUES($1,$2,'snapchat',$3,$4,$5,$6,now()+interval '72 hours') RETURNING expires_at`,[workspace,job,digest(token),encryptSocialSecret(url),imageUrl,deliveryId])).rows[0];
 await auditSocialEvent(workspace,user,'snapchat','manual_handoff_prepared','success',{publish_job_id:job,completion:'unknown'},c);
 await c.query('COMMIT');return {url,expires_at:result.expires_at,state:'handoff_ready',completion:'unknown'};
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
export async function readHandoff(token:string,db:Pick<Pool,'query'>=pool){
 if(!/^[a-f0-9]{64}$/.test(token))throw unavailable();
 const row=(await db.query(`SELECT h.*,j.approval_fingerprint,j.approved_account_id,j.approved_by,j.approved_at,v.copy,v.media_references,v.destination_reference,v.copy_approved_at,v.media_approved_at,v.approval_fingerprint variant_fingerprint,c.provider_account_id
 FROM growth_os.social_handoffs h JOIN growth_os.social_publish_jobs j ON j.id=h.publish_job_id AND j.workspace_id=h.workspace_id
 JOIN growth_os.social_content_variants v ON v.id=j.content_variant_id AND v.workspace_id=h.workspace_id
 JOIN growth_os.social_connections c ON c.id=j.connection_id AND c.workspace_id=h.workspace_id
 WHERE h.token_hash=$1 AND h.provider='snapchat' AND h.revoked_at IS NULL AND h.expires_at>now() AND j.status='approved' AND j.execution_state='not_started' AND c.provider='snapchat' AND c.status='connected'
 AND (h.media_delivery_id IS NULL OR EXISTS(SELECT 1 FROM growth_os.media_deliveries d JOIN growth_os.publishing_assets p ON p.id=d.publishing_asset_id JOIN growth_os.media_assets m ON m.id=p.media_asset_id WHERE d.id=h.media_delivery_id AND d.revoked_at IS NULL AND d.expires_at>now() AND p.state='approved' AND m.approved_for_use=true))`,[digest(token)])).rows[0];
 if(!row||!row.approved_by||!row.approved_at||!row.copy_approved_at||!row.media_approved_at||row.approved_account_id!==row.provider_account_id||row.destination_reference!==row.provider_account_id)throw unavailable();
 const fp=fingerprintSocialContent({copy:row.copy,media:row.media_references,destination:row.destination_reference});if(fp!==row.approval_fingerprint||fp!==row.variant_fingerprint)throw unavailable();
 return snapchatShareHtml(row.copy,row.image_url,`${deliveryOrigin()}/api/growth/social/handoffs/${token}`);
}
