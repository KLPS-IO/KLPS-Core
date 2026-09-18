// Restore a held release only after the new backend privacy controls are live.
const {Client}=require('pg');
async function restore(db){await db.query('BEGIN');try{
await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-readiness-release'))");
const r=(await db.query("SELECT * FROM finance_os.readiness_releases WHERE id='20260917_foundercatalyst_readiness_review_v1' FOR UPDATE")).rows[0];
if(r?.details?.held_schema!=='readiness_hold_20260917')throw Error('Expected held release missing');
const a='readiness_hold_20260917';
await db.query(`INSERT INTO finance_os.evidence SELECT * FROM ${a}.evidence`);
await db.query(`INSERT INTO finance_os.evidence_versions SELECT * FROM ${a}.evidence_versions`);
const fks=(await db.query(`SELECT c.conname,c.conrelid::regclass::text AS relation,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f' AND c.confrelid=$2::regclass`,[a,a+'.evidence'])).rows;
for(const f of fks){await db.query(`ALTER TABLE ${f.relation} DROP CONSTRAINT "${f.conname}"`);await db.query(`ALTER TABLE ${f.relation} ADD CONSTRAINT "${f.conname}" ${f.definition.replace(`REFERENCES ${a}.evidence(`,'REFERENCES finance_os.evidence(')}`);}
for(const t of ['fundraising_engagements','fundraising_requirements','fundraising_activity','ownership_snapshots','fundraising_scenarios'])await db.query(`ALTER TABLE ${a}.${t} SET SCHEMA finance_os`);
await db.query('UPDATE finance_os.readiness_releases SET details=details || $1::jsonb WHERE id=$2',[JSON.stringify({held_schema:null,restored_at:new Date().toISOString(),retained_archive:a}),r.id]);
const actual=(await db.query("SELECT holdings FROM finance_os.ownership_snapshots WHERE scope='ACTUAL'")).rows;if(actual.length!==1||actual[0].holdings[0].shares!==1)throw Error('Restored current ownership mismatch');
await db.query('COMMIT');return {restored:true,current_shares:1};
}catch(e){await db.query('ROLLBACK');throw e;}}
module.exports={restore};
if(require.main===module)(async()=>{if(!process.env.DATABASE_URL?.startsWith('postgresql://release_test@127.0.0.1:55439/readiness_release_test'))throw Error('Local-test-only CLI');const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();try{console.log(JSON.stringify(await restore(db)))}finally{await db.end()}})().catch(e=>{console.error(e.message);process.exit(1)});
