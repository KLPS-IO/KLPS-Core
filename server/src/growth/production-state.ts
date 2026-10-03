import type {PoolClient} from 'pg';
import {briefFingerprint,fingerprint,productionError} from './production-generation';
export const assetFingerprint=(a:any)=>fingerprint({key:a.storage_key,mime:a.mime_type,origin:a.provenance_kind,history:a.provenance_history,ratio:a.aspect_ratio,duration:a.duration_seconds,platforms:a.suitable_platforms});
export async function assertProduction(w:string,contentId:string,db:Pick<PoolClient,'query'>,execution?:{copy:string;media_references:any[]}){
 const row=(await db.query('SELECT c.*,p.narrative_plan,p.objective,p.audience FROM growth_os.content_items c LEFT JOIN growth_os.campaigns p ON p.id=c.campaign_id AND p.workspace_id=c.workspace_id WHERE c.workspace_id=$1 AND c.id=$2',[w,contentId])).rows[0];
 if(!row?.production_state)return;
 const s=row.production_state,hash=briefFingerprint(row,row),copy=s.candidates.find((x:any)=>x.id===s.copy_id);
 if(!copy?.approved_at||copy.rejected_at||copy.brief_hash!==hash||copy.caption!==row.caption||(copy.script||'')!==(row.script||''))throw productionError('Review and approve the current production copy first');
 if(execution&&execution.copy!==copy.caption)throw productionError('Provider copy differs from approved production copy; update and approve the production draft first');
 if(row.platform_brief.requirement.media_type==='none')return;
 const asset=s.candidates.find((x:any)=>x.id===s.asset_id);
 const media=asset?(await db.query('SELECT * FROM growth_os.media_assets WHERE workspace_id=$1 AND id=$2',[w,asset.media_asset_id])).rows[0]:null;
 if(!asset?.approved_at||asset.rejected_at||asset.brief_hash!==hash||!media?.approved_for_use||asset.asset_hash!==assetFingerprint(media)||row.platform_brief.asset_id!==media.id)throw productionError('Review and approve the current production asset first');
 if(execution){const ids=execution.media_references.map(x=>x.publishing_asset_id).filter(Boolean);const versions=ids.length?(await db.query('SELECT media_asset_id FROM growth_os.publishing_assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[w,ids])).rows:[];if(!versions.some(x=>x.media_asset_id===media.id))throw productionError('Provider media must use the selected approved production asset');}
}
