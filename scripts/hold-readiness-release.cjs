// Operator-only reversible hold. No records or ownership history are destroyed.
const {Client}=require('pg');
const archive='readiness_hold_20260917';
async function hold(db){await db.query('BEGIN');try{
await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-readiness-release'))");
const release=(await db.query("SELECT * FROM finance_os.readiness_releases WHERE id='20260917_foundercatalyst_readiness_review_v1' FOR UPDATE")).rows[0];if(!release)throw Error('Release ledger missing');
if(release.details?.held_schema){await db.query('COMMIT');return {alreadyHeld:true,archive};}
const ids=Object.values(release.details.evidenceIds);if(ids.length!==2)throw Error('Expected two imported evidence records');
await db.query(`CREATE SCHEMA ${archive}`);
await db.query(`CREATE TABLE ${archive}.release_record AS SELECT *,now() AS held_at FROM finance_os.readiness_releases WHERE id=$1`,[release.id]);
await db.query(`CREATE TABLE ${archive}.evidence (LIKE finance_os.evidence INCLUDING ALL)`);
await db.query(`INSERT INTO ${archive}.evidence SELECT * FROM finance_os.evidence WHERE id=ANY($1::uuid[])`,[ids]);
await db.query(`CREATE TABLE ${archive}.evidence_versions AS SELECT * FROM finance_os.evidence_versions WHERE evidence_id=ANY($1::uuid[])`,[ids]);
const tables=['fundraising_engagements','fundraising_requirements','fundraising_activity','ownership_snapshots','fundraising_scenarios'];const counts={};
for(const t of tables){counts[t]=Number((await db.query('SELECT count(*) AS n FROM finance_os.'+t)).rows[0].n);await db.query(`ALTER TABLE finance_os.${t} SET SCHEMA ${archive}`);}
const fks=(await db.query(`SELECT c.conname,c.conrelid::regclass::text AS relation,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f' AND c.confrelid='finance_os.evidence'::regclass`,[archive])).rows;
for(const f of fks){await db.query(`ALTER TABLE ${f.relation} DROP CONSTRAINT "${f.conname}"`);await db.query(`ALTER TABLE ${f.relation} ADD CONSTRAINT "${f.conname}" ${f.definition.replace('REFERENCES finance_os.evidence(',`REFERENCES ${archive}.evidence(`)}`);}
await db.query('LOCK TABLE finance_os.evidence_versions IN ACCESS EXCLUSIVE MODE');
await db.query('ALTER TABLE finance_os.evidence_versions DISABLE TRIGGER evidence_versions_no_delete');
await db.query('DELETE FROM finance_os.evidence_versions WHERE evidence_id=ANY($1::uuid[])',[ids]);
await db.query('ALTER TABLE finance_os.evidence_versions ENABLE TRIGGER evidence_versions_no_delete');
if((await db.query('DELETE FROM finance_os.evidence WHERE id=ANY($1::uuid[])',[ids])).rowCount!==2)throw Error('Hold count mismatch');
for(const t of tables)if(Number((await db.query(`SELECT count(*) AS n FROM ${archive}.${t}`)).rows[0].n)!==counts[t])throw Error('Archive count mismatch');
await db.query('UPDATE finance_os.readiness_releases SET details=details || $1::jsonb WHERE id=$2',[JSON.stringify({held_schema:archive,reason:'Backend unavailable; preserve private evidence outside active API until access controls are live',held_at:new Date().toISOString(),preserved_counts:counts}),release.id]);
await db.query(`REVOKE ALL ON SCHEMA ${archive} FROM PUBLIC`);await db.query('COMMIT');return {archive,preserved_counts:counts,active_imported_evidence:0};
}catch(e){await db.query('ROLLBACK');throw e;}}
module.exports={hold};
if(require.main===module)(async()=>{if(!process.env.DATABASE_URL?.startsWith('postgresql://release_test@127.0.0.1:55439/readiness_release_test'))throw Error('Local-test-only CLI');const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();try{console.log(JSON.stringify(await hold(db)))}finally{await db.end()}})().catch(e=>{console.error(e.message);process.exit(1)});
