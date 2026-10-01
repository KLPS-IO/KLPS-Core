// Explicit operator release only. Never invoked during application startup.
const fs=require('node:fs'),path=require('node:path');
async function apply(db) {
 await db.query('BEGIN');
 try {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('growth-attribution-phase5a'))");
  const existing=(await db.query("SELECT to_regclass('growth_os.tracked_link_visits') present")).rows[0].present;
  if(existing) {
   const check=(await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='waitlist_signups' AND column_name='acquisition_visit_id'")).rows[0].n;
   const trigger=(await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='public.waitlist_signups'::regclass AND tgname='preserve_waitlist_acquisition' AND tgenabled='O'")).rows[0].n;
   if(check!==1||trigger!==1)throw Error('Partial attribution schema: manual inspection required');
   await db.query('COMMIT');return {already_applied:true};
  }
  const duplicates=(await db.query("SELECT count(*)::int n FROM (SELECT lower(trim(email)) FROM public.waitlist_signups GROUP BY 1 HAVING count(*)>1) d")).rows[0].n;
  const whitespace=(await db.query("SELECT count(*)::int n FROM public.waitlist_signups WHERE email<>trim(email)")).rows[0].n;
  if(duplicates||whitespace)throw Error('Existing email normalisation needs an ownership decision');
  await db.query("SET LOCAL lock_timeout='5s'");
  const sql=fs.readFileSync(path.join(__dirname,'../server/sql/20261001_growth_attribution.sql'),'utf8').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
  await db.query(sql);await db.query('COMMIT');return {applied:true};
 } catch(error) {await db.query('ROLLBACK');throw error;}
}
module.exports={apply};
