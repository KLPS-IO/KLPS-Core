// Explicit operator release, never run by startup/build. Original file upload is a separate,
// hash-verified private R2 operation; this transaction registers and links those originals.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {initialiseDebtApplication,saveDebtItem}=require('../dist/server/src/services/debt-application.service');
const {WORKBOOK,GUIDE}=require('../dist/server/src/services/debt-application.template');
const releaseId='20260923_debt_application_workspace_v1';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function apply(db,manifest){
 if(manifest.sources?.length!==2)throw Error('Two unchanged official source files are required');
 for(const [i,expected] of [WORKBOOK,GUIDE].entries()){
  const source=manifest.sources[i];const bytes=fs.readFileSync(source.local_path);
  if(source.filename!==expected.filename||source.sha256!==expected.sha256||sha(bytes)!==expected.sha256||source.size!==bytes.length||source.object_key!==`restricted/debt-applications/sources/${expected.sha256}/${expected.filename}`)throw Error('Original source manifest mismatch');
 }
 const sql=fs.readFileSync(path.join(__dirname,'../server/sql/20260923_debt_application_workspace.sql'),'utf8');
 const manifestHash=sha(JSON.stringify(manifest.sources.map(({local_path,...source})=>source)));
 await db.query('BEGIN');try{
  await db.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-debt-application-release'))");
  const prior=(await db.query('SELECT * FROM finance_os.readiness_releases WHERE id=$1 FOR UPDATE',[releaseId])).rows[0];
  if(prior){if(prior.manifest_sha256!==manifestHash||prior.migration_sha256!==sha(sql))throw Error('Applied release hash conflict');await db.query('COMMIT');return {already_applied:true,...prior.details};}
  if((await db.query("SELECT to_regclass('finance_os.debt_applications') present")).rows[0].present)throw Error('Schema exists without release ledger; reconcile before applying');
  const users=(await db.query("SELECT id FROM data_room.users WHERE email='emmamendez07@gmail.com' AND role='founder_admin' AND is_active=true")).rows;
  if(users.length!==1)throw Error('Existing founder/applicant identity is ambiguous');const actor=users[0].id;
  await db.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  const app=await initialiseDebtApplication(actor,db);const evidenceIds=[];
  for(const [i,source] of manifest.sources.entries()){
   const existing=(await db.query('SELECT * FROM finance_os.evidence WHERE checksum=$1 FOR UPDATE',[source.sha256])).rows;
   if(existing.length>1)throw Error('Duplicate original source evidence requires reconciliation');
   let ev=existing[0];
   if(ev){if(!ev.founder_only||ev.r2_object_key!==source.object_key||ev.verification_status!=='Verified'||ev.document_status!=='Active')throw Error('Existing original source requires review');}
   else{
    ev=(await db.query(`INSERT INTO finance_os.evidence(evidence_type,title,description,document_category,source_organisation,verification_status,document_status,storage_provider,r2_object_key,original_filename,mime_type,file_size,checksum,founder_only,metadata,created_by,updated_by,change_reason)
     VALUES('document',$1,$2,'Finance','Start Up Loans','Verified','Active','r2',$3,$4,$5,$6,$7,true,$8,$9,$9,'Preserved founder-supplied source byte-for-byte; no workbook repair or population') RETURNING *`,
     [i===0?'Start Up Loans 2026 official workbook — original unchanged':'Start Up Loans business plan guide — original November 2020',
     'Verified exact original supplied by founder by SHA-256. Verification establishes source identity only, not template fitness, applicant eligibility or a completed application. Workbook defects remain recorded separately.',source.object_key,source.filename,source.mime_type,source.size,source.sha256,JSON.stringify({release_id:releaseId,source_role:i===0?'original_workbook':'original_guide',byte_preserved:true}),actor])).rows[0];
    await db.query('INSERT INTO finance_os.evidence_versions(evidence_id,version,snapshot,change_reason,created_by) VALUES($1,$2,$3,$4,$5)',[ev.id,ev.version,JSON.stringify(ev),ev.change_reason,actor]);
   }
   const item=(await db.query('SELECT * FROM finance_os.debt_application_items WHERE application_id=$1 AND code=$2',[app.id,i===0?'original-workbook':'original-guide'])).rows[0];
   await saveDebtItem(app.id,item.id,{version:item.version,data:item.data,status:'Resolved',classification:'Extracted fact',source:'Founder-supplied official source, byte-for-byte checksum verified',source_date:'2026-09-23',evidence_id:ev.id,evidence_version:ev.version,evidence_file_version:ev.file_version,locator:'Original file; full SHA-256 recorded in application source metadata',rationale:'Original source identity preserved. This does not resolve workbook defects, drafting or current lender requirements.',next_action:i===0?'Obtain a clean/replacement official workbook before population; do not repair this original.':'Reconcile 2020 guidance with current lender requirements before drafting.',review_confirmed:true},actor,db);
   evidenceIds.push(ev.id);
  }
  const details={application_id:app.id,evidence_ids:evidenceIds,scope:'Internal preparation only',ledger_entries_created:0,facility_created:false,submitted:false};
  await db.query('INSERT INTO finance_os.readiness_releases(id,actor_id,manifest_sha256,migration_sha256,details) VALUES($1,$2,$3,$4,$5)',[releaseId,actor,manifestHash,sha(sql),JSON.stringify(details)]);
  await db.query('COMMIT');return details;
 }catch(e){await db.query('ROLLBACK');throw e;}
}
module.exports={apply,releaseId};
