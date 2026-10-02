import {randomUUID} from 'crypto';
import {digest,jpeg} from './media-delivery.service';
import {pool} from '../storage/postgres.client';
import {uploadToR2,deleteFromR2,readFromR2} from '../services/r2.service';
const fail=()=>Object.assign(new Error('Upload a JPEG, PNG or MP4 file (maximum 40 MB)'),{statusCode:400,code:'planning_media_invalid'});
export function sourceMediaType(b:Buffer){
 if(b.length<12||b.length>40*1024*1024)throw fail();
 if(b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217)return {mime:'image/jpeg',ext:'jpg',kind:'image'};
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png',kind:'image'};
 if(b.toString('ascii',4,8)==='ftyp'&&['isom','iso2','mp41','mp42','avc1','M4V '].includes(b.toString('ascii',8,12)))return {mime:'video/mp4',ext:'mp4',kind:'video'};
 throw fail();
}
export async function uploadPlanningMedia(w:string,bytes:Buffer,name:string){
 const t=sourceMediaType(bytes),id=randomUUID(),key=`growth-source/${w}/${id}.${t.ext}`;
 await uploadToR2(key,bytes,t.mime);try{const row=(await pool.query('INSERT INTO growth_os.media_assets(id,workspace_id,filename,display_name,asset_type,mime_type,storage_key) VALUES($1,$2,$3,$3,$4,$5,$6) RETURNING id,display_name,mime_type,approved_for_use',[id,w,String(name||'Founder media').replace(/[\x00-\x1f/\\]/g,'').slice(0,150),t.kind,t.mime,key])).rows[0];return row;}catch(e){await deleteFromR2(key).catch(()=>undefined);throw e;}
}
export async function previewPlanningMedia(w:string,id:string){
 const row=(await pool.query('SELECT storage_key,mime_type FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2',[w,id])).rows[0];
 if(row?.storage_key?.startsWith(`growth-source/${w}/`)){const file=await readFromR2(row.storage_key);return {body:file.body,mime:row.mime_type};}
 // Legacy source metadata may keep its actual bytes in an existing publishing version.
 const version=(await pool.query("SELECT object_key,sha256 FROM growth_os.publishing_assets WHERE workspace_id=$1 AND media_asset_id=$2 AND state<>'revoked' ORDER BY created_at DESC LIMIT 1",[w,id])).rows[0];
 if(!version)throw Object.assign(new Error('Private preview unavailable'),{statusCode:404});const file=await readFromR2(version.object_key);if(!jpeg(file.body)||digest(file.body)!==version.sha256)throw Object.assign(new Error('Private preview unavailable'),{statusCode:404});return {body:file.body,mime:'image/jpeg'};
}
