const fs=require('node:fs'),path=require('node:path');
async function apply(db){await db.query('BEGIN');try{
 await db.query("SELECT pg_advisory_xact_lock(hashtext('growth-planner-phase5c'))");
 const r=(await db.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='growth_os' AND table_name='campaigns' AND column_name='narrative_plan') opportunities,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='growth_os' AND table_name='content_items' AND column_name='platform_brief') decisions")).rows[0];
 if(r.opportunities||r.decisions){if(!r.opportunities||!r.decisions)throw Error('Partial narrative schema requires inspection');await db.query('COMMIT');return {already_applied:true};}
 await db.query("SET LOCAL lock_timeout='5s'");
 await db.query(fs.readFileSync(path.join(__dirname,'../server/sql/20261002_growth_planner.sql'),'utf8').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
 await db.query('COMMIT');return {applied:true};
}catch(e){await db.query('ROLLBACK');throw e;}}
module.exports={apply};
