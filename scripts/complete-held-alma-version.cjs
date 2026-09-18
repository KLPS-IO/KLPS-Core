// One-time completion of metadata omitted by an archive table without defaults.
// Original PDF bytes, checksum, source snapshot and evidence version remain unchanged.
async function completeHeldVersion(db){await db.query('BEGIN');try{
 await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-readiness-release'))");
 const schema='readiness_hold_20260917';
 const held=(await db.query("SELECT details->>'held_schema' AS held FROM finance_os.readiness_releases WHERE id='20260917_foundercatalyst_readiness_review_v1' FOR SHARE")).rows[0];if(held?.held!==schema)throw Error('Expected active hold');
 const ev=(await db.query(`SELECT id,checksum,created_by FROM ${schema}.evidence WHERE metadata->>'source_key'='alma-distribution-20260917'`)).rows;
 if(ev.length!==1)throw Error('Expected single Alma original');
 const rows=(await db.query(`UPDATE ${schema}.evidence_versions SET id=COALESCE(id,gen_random_uuid()),created_at=COALESCE(created_at,now()) WHERE evidence_id=$1 AND version=1 AND (id IS NULL OR created_at IS NULL) RETURNING id,created_at`,[ev[0].id])).rows;
 if(rows.length>1)throw Error('Ambiguous original version');
 if(rows.length){const event=(await db.query(`SELECT engagement_id FROM ${schema}.fundraising_activity WHERE evidence_id=$1 AND payload->>'event_key'='alma-distribution-20260917'`,[ev[0].id])).rows[0];if(!event)throw Error('Source activity missing');await db.query(`INSERT INTO ${schema}.fundraising_activity(engagement_id,kind,description,evidence_id,recorded_by,source,payload) VALUES ($1,'audit','Completed missing original evidence-version ID and recording timestamp caused by archive table defaults. Original source bytes, checksum and version snapshot unchanged.',$2,$3,'Hold-and-restore validation',$4)`,[event.engagement_id,ev[0].id,ev[0].created_by,JSON.stringify({evidence_version:1,completion_recorded_at:rows[0].created_at,backdated:false,source_content_changed:false})]);}
 await db.query('COMMIT');return {completed:rows.length,evidence_id:ev[0].id};
}catch(e){await db.query('ROLLBACK');throw e;}}
module.exports={completeHeldVersion};
