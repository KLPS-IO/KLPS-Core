/* Explicit operator-run migration/data importer. Never called by build/start/deployment. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const {Client} = require('pg');
const {initialiseReadiness, getReadiness} = require('../dist/server/src/services/fundraising-readiness.service');
const migrationId = '20260917_foundercatalyst_readiness_review_v1';
async function apply(db, manifest) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-readiness-release'))");
    await db.query(`CREATE TABLE IF NOT EXISTS finance_os.readiness_releases (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), actor_id uuid NOT NULL REFERENCES data_room.users(id), manifest_sha256 text NOT NULL, migration_sha256 text NOT NULL, details jsonb NOT NULL)`);
    const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const existing=(await db.query('SELECT * FROM finance_os.readiness_releases WHERE id=$1',[migrationId])).rows[0];
    if(existing) { if(existing.manifest_sha256!==hash) throw Error('Release manifest differs from applied release'); await db.query('COMMIT'); return {alreadyApplied:true,id:migrationId}; }
    const actor=(await db.query("SELECT id FROM data_room.users WHERE email='emmamendez07@gmail.com' AND role='founder_admin'")).rows;
    if(actor.length!==1) throw Error('Expected existing founder/admin not found');
    const company=(await db.query("SELECT id FROM finance_os.company WHERE company_number='16436591'")).rows;
    if(company.length!==1) throw Error('Canonical company is ambiguous');
    if((await db.query("SELECT to_regclass('finance_os.ownership_snapshots') AS present")).rows[0].present) throw Error('Readiness tables already exist without release ledger; reconcile before proceeding');
    const sql=fs.readFileSync(require('path').join(__dirname,'../server/sql/20260915_fundraising_readiness.sql'),'utf8');
    await db.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
    const user=actor[0].id;
    const evidenceIds={};
    for(const item of manifest.evidence) {
      if(!/^[a-f0-9]{64}$/.test(item.sha256) || !item.object_key.startsWith('restricted/foundercatalyst/')) throw Error('Invalid restricted evidence manifest');
      const row=(await db.query(`INSERT INTO finance_os.evidence(evidence_type,title,description,document_category,source_organisation,owner,verification_status,document_status,storage_provider,r2_object_key,original_filename,mime_type,file_size,checksum,document_date,created_by,updated_by,founder_only,metadata,change_reason)
        VALUES ('document',$1,$2,'Corporate','KLPS Ltd','Emma Louise Mendez',$3,$4,'r2',$5,$6,$7,$8,$9,$10,$11,$11,true,$12,'Founder-authorised readiness publication; no corporate action') RETURNING *`,
        [item.title,item.description,item.verified?'Verified':'Under Review',item.verified?'Active':'Draft',item.object_key,item.filename,item.mime_type,item.size,item.sha256,item.document_date,user,JSON.stringify({release_id:migrationId,source_key:item.key,execution_status:'NOT_EXECUTED'})])).rows[0];
      evidenceIds[item.key]=row.id;
      await db.query('INSERT INTO finance_os.evidence_versions(evidence_id,version,snapshot,change_reason,created_by) VALUES ($1,1,$2,$3,$4)',[row.id,JSON.stringify(row),row.change_reason,user]);
    }
    if(!evidenceIds.ownership || !evidenceIds.review) throw Error('Ownership and review evidence required');
    // Legacy ownership records remain unverified and private; they do not supply the current holding.
    const protectedRows=(await db.query(`UPDATE finance_os.evidence SET founder_only=true WHERE id=ANY($1::uuid[]) RETURNING id`,[manifest.restrict_existing_evidence_ids])).rows;
    await db.query(`UPDATE data_room.documents d SET access_level='founder_only',updated_at=now() WHERE EXISTS(SELECT 1 FROM finance_os.evidence e WHERE e.founder_only AND (d.evidence_id=e.id OR d.storage_path=e.r2_object_key))`);
    const engagement=await initialiseReadiness(user,db);
    const holding={shareholder:'Emma Louise Mendez',shareholder_type:'Individual',share_class:'Ordinary',shares:1,nominal_value:1,amount_paid:1,amount_unpaid:0,acquisition_date:'2025-05-08',voting_rights:'One vote per Ordinary share',notes:'Sole registered and beneficial holder; name reconciliation confirmed by director 17 September 2026.'};
    for(const [scope,date,name,notes] of [['HISTORICAL','2025-05-08','Emma Mendez','Incorporation snapshot, retained separately. Identity reconciled to Emma Louise Mendez.'],['ACTUAL','2026-09-17','Emma Louise Mendez','Verified incorporation plus reconstructed register dated 17 September 2026 and explicit director confirmation of no subsequent events through that date. Document was reconstructed in 2026, not backdated. Physical custody not independently inspected.']]) {
      await db.query(`INSERT INTO finance_os.ownership_snapshots(company_id,scope,effective_date,verification_status,holdings,evidence_id,evidence_version,review_notes,approved_by) VALUES ($1,$2,$3,'VERIFIED',$4,$5,1,$6,$7)`,[company[0].id,scope,date,JSON.stringify([{...holding,shareholder:name}]),evidenceIds.ownership,notes,user]);
    }
    for(const [code,classification,next,notes,key] of [
      ['FC04','AVAILABLE + VERIFIED','Ready for provider review — verified pre-split current cap table.','Emma Louise Mendez / 1 Ordinary / £1 nominal / £1 paid / £0 unpaid / 100%. Proposed 10,000 shares must never be entered as current.','ownership'],
      ['FC05','AVAILABLE + REVIEW REQUIRED','Approved in principle — pending FounderCatalyst/final execution review.','NOT PASSED; NOT EXECUTED; NOT FILED. Review resolution, statutory s297 lapse rule, SH02 mapping, articles, certificate history and execution sequence before separate execution authority.','review'],
      ['CR01','AVAILABLE + VERIFIED','Retain the reconstructed register and evidence chain.','Current issued ownership verified through director confirmation dated 17 September 2026; historical incorporation snapshot retained separately.','ownership']]) {
      const r=await db.query(`UPDATE finance_os.fundraising_requirements SET classification=$1,next_action=$2,notes=$3,evidence_id=$4,reviewed_evidence_version=1,updated_by=$5,version=version+1,updated_at=now() WHERE engagement_id=$6 AND code=$7`,[classification,next,notes,evidenceIds[key],user,engagement.id,code]);
      if(r.rowCount!==1) throw Error('Missing requirement '+code);
    }
    await db.query(`INSERT INTO finance_os.fundraising_activity(engagement_id,kind,description,evidence_id,occurred_on,recorded_by,source,payload) VALUES ($1,'founder_decision',$2,$3,'2026-09-17',$4,'Explicit founder instruction in Codex, 17 September 2026',$5)`,[engagement.id,'Subdivision approved IN PRINCIPLE ONLY. Pending FounderCatalyst/final professional review. No passing, signature, execution, filing or change to issued capital.',evidenceIds.review,user,JSON.stringify({decision_key:'subdivision-review-20260917',review_evidence_id:evidenceIds.review,effect:'REVIEW_ONLY'})]);
    const details={evidenceIds,protectedRows,scope:'Readiness and review only',legal_actions:[],external_actions:[]};
    await db.query(`INSERT INTO finance_os.fundraising_activity(engagement_id,kind,description,recorded_by,source,payload) VALUES ($1,'audit','Published founder-authorised readiness evidence and separate review proposal; no financing or corporate event',$2,$3,$4)`,[engagement.id,user,migrationId,JSON.stringify(details)]);
    const state=await getReadiness(db); const current=state.ownership.find(s=>s.scope==='ACTUAL');
    if(!current?.usable || current.calculated.shares!==1 || current.calculated.nominal_capital!==1 || current.calculated.total_ownership!==1) throw Error('Current cap table failed release gate');
    await db.query('INSERT INTO finance_os.readiness_releases(id,actor_id,manifest_sha256,migration_sha256,details) VALUES ($1,$2,$3,$4,$5)',[migrationId,user,hash,crypto.createHash('sha256').update(sql).digest('hex'),JSON.stringify(details)]);
    await db.query('COMMIT'); return {id:migrationId,...details};
  } catch(e) {await db.query('ROLLBACK');throw e;}
}
module.exports={apply,migrationId};
if(require.main===module) (async()=>{if(process.env.READINESS_RELEASE_APPROVED!=='20260917') throw Error('Explicit release approval flag required');const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const db=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='require'?{rejectUnauthorized:false}:false});await db.connect();try{console.log(JSON.stringify(await apply(db,manifest)))}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exit(1)});
