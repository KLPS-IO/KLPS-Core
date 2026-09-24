// Explicit transactional operator release. Personal figures are supplied from a restricted
// external manifest, never embedded in source control or the generic release ledger.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const service=require('../dist/server/src/services/debt-application.service');
const {PASS3_BUSINESS_ITEMS}=require('../dist/server/src/services/debt-readiness');
const releaseId='20260924_debt_psb_reconciliation_v1';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function apply(db,manifest){
 const sql=fs.readFileSync(path.join(__dirname,'../server/sql/20260924_debt_psb_reconciliation.sql'),'utf8');const manifestHash=sha(JSON.stringify(manifest));
 await db.query('BEGIN');try{
  await db.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-debt-application-release'))");
  const prior=(await db.query('SELECT * FROM finance_os.readiness_releases WHERE id=$1 FOR UPDATE',[releaseId])).rows[0];
  if(prior){if(prior.manifest_sha256!==manifestHash||prior.migration_sha256!==sha(sql))throw Error('Applied release hash conflict');await db.query('COMMIT');return {already_applied:true,...prior.details};}
  if((await db.query("SELECT to_regclass('finance_os.debt_psb_reconciliations') present")).rows[0].present)throw Error('Schema exists without release ledger');
  const app=(await db.query(`SELECT a.* FROM finance_os.debt_applications a JOIN data_room.users u ON u.id=a.applicant_id JOIN finance_os.company c ON c.id=a.company_id WHERE a.id=$1 AND u.role='founder_admin' AND u.is_active=true AND c.company_number='16436591' FOR UPDATE OF a`,[manifest.application_id])).rows[0];
  if(!app||app.version!==manifest.application_version)throw Error('Application changed or founder ownership unresolved');
  const actor=app.applicant_id;
  const items=(await db.query('SELECT * FROM finance_os.debt_application_items WHERE application_id=$1 FOR UPDATE',[app.id])).rows;
  if(items.length!==manifest.item_versions.length||items.some(i=>!manifest.item_versions.some(v=>v.id===i.id&&v.version===i.version)))throw Error('Application items changed; reconcile before release');
  if(!Array.isArray(manifest.entries)||manifest.entries.length!==29)throw Error('Complete official category manifest required');
  await db.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  for(const entry of manifest.entries)await service.savePrivatePsb(app.id,entry.id,entry.input,actor,db);
  const checkpoint=await service.reconcilePrivatePsb(app.id,manifest.reconciliation,actor,db);
  for(const seed of PASS3_BUSINESS_ITEMS){
   if(items.some(i=>i.code===seed.code))throw Error('Pass 3 item already exists without release ledger');
   const row=(await db.query(`INSERT INTO finance_os.debt_application_items(application_id,code,section,title,application_field,status,data,source,source_date,classification,rationale,next_action,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[app.id,seed.code,seed.section,seed.title,seed.field,seed.status,JSON.stringify(service.validateData(seed.section,seed.data)),'Founder Pass 3 instructions; business hypothesis / preparation only','2026-09-24',seed.classification,'Unknown costs and dates remain blank; no lender application drafted or financial event created.',seed.action,actor])).rows[0];
   await db.query("INSERT INTO finance_os.debt_application_history(application_id,entity_id,entity_kind,entity_version,snapshot,actor_id) VALUES($1,$2,'item',1,$3,$4)",[app.id,row.id,JSON.stringify(row),actor]);
  }
  const affordability=items.find(i=>i.code==='affordability');
  await service.saveDebtItem(app.id,affordability.id,{version:affordability.version,title:'Working personal budget reconciled — private follow-up separate',data:{finding:'Founder working inputs and official-category arithmetic reconciled in the private PSB. Evidence review and temporary commitment timing remain private follow-ups; lender affordability is not approved. Fallback has its own founder-review task.'},status:'Resolved',classification:'Founder statement',source:'Explicit founder-approved working reconciliation',source_date:'2026-09-24',rationale:'Closes working input intake only; version-pinned private reconciliation controls readiness.',next_action:'Review remaining private evidence/commitment warnings; progress business cash, quotes, economics and forecast gates.',review_confirmed:true},actor,db);
  const pricing=items.find(i=>i.code==='commercial-2');
  await service.saveDebtItem(app.id,pricing.id,{version:pricing.version,data:{...pricing.data,finding:'Founder commercial hypothesis approximately £150–£250+ per garment. Not validated, not a selected launch price and not current revenue. Structured costing is in Product economics; historic price ranges are not adopted.'},status:'Provisional',classification:'Assumption',source:'Founder Pass 3 commercial hypothesis',source_date:'2026-09-24',rationale:'Cost, VAT, production path and channel evidence must justify a selected future price.',next_action:'Obtain product costs and test the commercial hypothesis; leave selected price and sales blank.'},actor,db);
  await service.recordDebtReview(app.id,{reason:'Pass 3 working intake reconciled privately; business readiness gates isolated. Internal preparation only; no lender drafting, export, submission or accounting effects.',review_confirmed:true},actor,db);
  const details={application_id:app.id,private_reconciliation_id:checkpoint.id,scope:'Internal preparation only',accounting_effects:false,submitted:false};
  await db.query('INSERT INTO finance_os.readiness_releases(id,actor_id,manifest_sha256,migration_sha256,details) VALUES($1,$2,$3,$4,$5)',[releaseId,actor,manifestHash,sha(sql),JSON.stringify(details)]);
  await db.query('COMMIT');return details;
 }catch(e){await db.query('ROLLBACK');throw e;}
}
module.exports={apply,releaseId};
