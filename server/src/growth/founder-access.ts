import type {PoolClient} from 'pg';
/** Shared workspace-owner boundary for planning and explicit social actions. */
export async function founder(c:Pick<PoolClient,'query'>,workspace:string,user:string){
 const r=await c.query(`SELECT w.id FROM growth_os.workspaces w JOIN data_room.users u ON u.id=w.owner_user_id
 WHERE w.id=$1 AND u.id=$2 AND u.role='founder_admin' AND coalesce(u.is_active,true) AND (u.expires_at IS NULL OR u.expires_at>now())`,[workspace,user]);
 if(!r.rows.length)throw Object.assign(new Error('Only the workspace founder can approve or publish.'),{code:'social_founder_required',statusCode:403});
}
