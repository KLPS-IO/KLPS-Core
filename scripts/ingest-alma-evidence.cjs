// Operator-only canonical ingestion. Source/provenance manifest stays outside Git.
const fs=require('fs'),crypto=require('crypto');
async function ingest(db,manifest,schema){
 if(!['finance_os','readiness_hold_20260917'].includes(schema))throw Error('Unsupported evidence schema');
 const original=fs.readFileSync(manifest.local_path);if(crypto.createHash('sha256').update(original).digest('hex')!==manifest.sha256)throw Error('Original hash mismatch');
 if(manifest.source_key!=='alma-distribution-20260917'||manifest.document_date!=='2026-09-17'||!manifest.r2_object_key.startsWith('restricted/foundercatalyst/alma/'+manifest.sha256+'/'))throw Error('Unexpected source identity');
 await db.query('BEGIN');try{
 await db.query("SELECT pg_advisory_xact_lock(hashtext('klps-readiness-release'))");
 if(schema==='readiness_hold_20260917') {const held=(await db.query("SELECT details->>'held_schema' AS held FROM finance_os.readiness_releases WHERE id='20260917_foundercatalyst_readiness_review_v1' FOR SHARE")).rows[0];if(held?.held!==schema)throw Error('Production evidence hold is not active');}
 const company=(await db.query("SELECT id FROM finance_os.company WHERE company_number='16436591'")).rows;
 const users=(await db.query("SELECT id FROM data_room.users WHERE email='emmamendez07@gmail.com' AND role='founder_admin'")).rows;
 if(company.length!==1||users.length!==1)throw Error('Canonical company/founder ambiguity');const actor=users[0].id;
 const duplicate=(await db.query(`SELECT id,checksum FROM ${schema}.evidence WHERE metadata->>'source_key'=$1`,[manifest.source_key])).rows;
 if(duplicate.length){if(duplicate.length!==1||duplicate[0].checksum!==manifest.sha256)throw Error('Source conflict');await db.query('COMMIT');return {already_ingested:true,evidence_id:duplicate[0].id,schema};}
 const {local_path,r2_object_key,...provenance}=manifest;
 const ev=(await db.query(`INSERT INTO ${schema}.evidence(evidence_type,title,description,document_category,source_organisation,verification_status,document_status,storage_provider,r2_object_key,original_filename,mime_type,file_size,checksum,document_date,founder_only,metadata,created_by,updated_by,change_reason)
 VALUES ('document',$1,'Original Alma email export confirming distribution only; private email headers retained in restricted provenance.','Fundraising','Alma Angels','Verified','Active','r2',$2,$3,'application/pdf',$4,$5,'2026-09-17',true,$6,$7,$7,'Original Alma communication supplied by founder; source verified; no financing or corporate event') RETURNING *`,[manifest.title,r2_object_key,manifest.original_filename,original.length,manifest.sha256,JSON.stringify(provenance),actor])).rows[0];
 await db.query(`INSERT INTO ${schema}.evidence_versions(id,evidence_id,version,snapshot,change_reason,created_by,created_at) VALUES (gen_random_uuid(),$1,1,$2,$3,$4,now())`,[ev.id,JSON.stringify(ev),ev.change_reason,actor]);
 const channel=(await db.query(`INSERT INTO ${schema}.fundraising_engagements(company_id,provider,purpose,status,budget_ex_vat,price_basis,updated_by) VALUES ($1,'Alma Angels','Investor community distribution and founder-controlled outreach','In progress',NULL,'Not a purchased service or financing transaction',$2) ON CONFLICT(company_id,provider) DO UPDATE SET purpose=EXCLUDED.purpose RETURNING id`,[company[0].id,actor])).rows[0];
 const payload={event_key:manifest.source_key,event_type:'Investor community distribution',stage:'DISTRIBUTED TO INVESTOR COMMUNITY',evidence_version:1,communication_status:'RECEIVED FROM ALMA',source_facts:manifest.facts,source_type:'Original founder-supplied Gmail PDF export',effect:'RECORD_ONLY',downstream_events_created:[],no_automatic_progression:true,significant_updates_require_founder_approval:true};
 const activity=(await db.query(`INSERT INTO ${schema}.fundraising_activity(engagement_id,kind,description,evidence_id,occurred_on,recorded_by,source,payload) VALUES ($1,'correspondence','KLPS venture shared with Alma community. Distribution only; no investor interest, meeting, diligence, proposal, commitment, cash receipt or share issuance established.',$2,'2026-09-17',$3,'Original Alma Angels email export supplied by founder',$4) RETURNING id`,[channel.id,ev.id,actor,JSON.stringify(payload)])).rows[0];
 await db.query('COMMIT');return {schema,evidence_id:ev.id,evidence_version:1,channel_id:channel.id,activity_id:activity.id,stage:payload.stage};
 }catch(e){await db.query('ROLLBACK');throw e;}
}
module.exports={ingest};
