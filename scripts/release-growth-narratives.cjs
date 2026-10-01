const fs=require('node:fs'),path=require('node:path');
async function apply(db){await db.query('BEGIN');try{
 await db.query("SELECT pg_advisory_xact_lock(hashtext('growth-narratives-phase5b'))");
 const r=(await db.query("SELECT to_regclass('growth_os.narrative_opportunities') opportunities,to_regclass('growth_os.narrative_decisions') decisions")).rows[0];
 if(r.opportunities||r.decisions){if(!r.opportunities||!r.decisions)throw Error('Partial narrative schema requires inspection');await db.query('COMMIT');return {already_applied:true};}
 await db.query("SET LOCAL lock_timeout='5s'");
 await db.query(fs.readFileSync(path.join(__dirname,'../server/sql/20261001_growth_narratives.sql'),'utf8').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
 await db.query('COMMIT');return {applied:true};
}catch(e){await db.query('ROLLBACK');throw e;}}
module.exports={apply};
