import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { fail, required, uuid } from './fundraising-readiness.service';
import { cashAuthority } from './finance-canonical.service';
import { FIELDS, GUIDE, PSB_ROWS, SEEDS, Section, TEMPLATE_VERSION, WORKBOOK } from './debt-application.template';
type Db=Pick<PoolClient,'query'>;
type Input=Record<string,unknown>;
type Row=Record<string,any>;
export const ITEM_STATUSES=['Missing','Founder input','External evidence','Review required','Provisional','Resolved','Not applicable'];
export const CLASSIFICATIONS=['Unknown','Extracted fact','Founder statement','Assumption','Calculation','Conflict'];
export const APPLICATION_STATUSES=['Preparing','Awaiting founder','Awaiting external evidence','Founder review','Paused'];
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const optional=(v:unknown)=>v==null||v===''?'':required(v,'Text');
const choose=(v:unknown,values:string[],name:string)=>{if(typeof v!=='string'||!values.includes(v))throw fail(`Invalid ${name}`);return v;};
const only=(v:Input,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw fail('Unsupported input fields');};
export function amount(v:unknown):number|null {
 if(v===null||v===undefined||v==='')return null;
 if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e9||Math.abs(v*100-Math.round(v*100))>0.0001)throw fail('Use non-negative amounts with at most two decimal places; leave unknown amounts blank');
 return v;
}
function date(v:unknown):string|null {
 if(v==null||v==='')return null;
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw fail('Invalid date');
 return v;
}
function pastDate(v:unknown){const d=date(v);if(d&&d>new Date().toISOString().slice(0,10))throw fail('Source dates cannot be in the future');return d;}
function version(v:unknown){if(!Number.isSafeInteger(v)||Number(v)<1)throw fail('Current version is required');return Number(v);}
export function indicativePayment(principal:number,months:number,rate:number){
 if(!Number.isFinite(principal)||principal<=0||!Number.isInteger(months)||months<12||months>60||!Number.isFinite(rate)||rate<0||rate>1)throw fail('Invalid indicative loan terms');
 const monthly=rate/12;const raw=monthly===0?principal/months:principal*monthly/(1-Math.pow(1+monthly,-months));
 return {monthly:round(raw),total:round(raw*months),interest:round(raw*months-principal),basis:'Indicative amortisation only; lender rounding and terms require confirmation. No facility or repayment schedule is created.'};
}
export function validateData(section:Section,value:unknown){
 const data=(value??{}) as Input;only(data,FIELDS[section].map(f=>f.key));const result:Input={};
 for(const f of FIELDS[section]){
  const v=data[f.key];
  if(f.type==='money')result[f.key]=amount(v);
  else if(f.type==='number'){if(v!=null&&v!==''&&(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1e6))throw fail('Quantity must be positive');result[f.key]=v===''||v==null?null:v;}
  else if(f.type==='date')result[f.key]=date(v);
  else if(f.type==='select')result[f.key]=v==null||v===''?f.options![0]:choose(v,f.options!,f.label);
  else result[f.key]=optional(v);
 }
 if(section==='budget'&&result.net!=null&&result.vat!=null&&result.gross!=null&&Math.abs(Number(result.net)+Number(result.vat)-Number(result.gross))>0.005)throw fail('Net plus VAT must equal gross');
 if(section==='document'&&result.sha256&&!/^[a-f0-9]{64}$/.test(String(result.sha256)))throw fail('Invalid SHA-256');
 return result;
}
async function application(id:string,actor:string,db:Db,lock=false){
 const result=await db.query(`SELECT a.*,a.rate_as_of::text,a.forecast_start::text FROM finance_os.debt_applications a JOIN finance_os.company c ON c.id=a.company_id WHERE a.id=$1 AND a.applicant_id=$2 AND c.company_number='16436591' ${lock?'FOR UPDATE OF a':''}`,[uuid(id),uuid(actor)]);
 if(!result.rows[0])throw fail('Application not found',404);return result.rows[0];
}
async function history(app:string,entity:string,kind:string,v:number,snapshot:unknown,actor:string,db:Db){
 await db.query('INSERT INTO finance_os.debt_application_history(application_id,entity_id,entity_kind,entity_version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[app,entity,kind,v,JSON.stringify(snapshot),actor]);
}
async function linkEvidence(input:Input,db:Db){
 if(!input.evidence_id)return {id:null,version:null,file_version:null};
 const r=(await db.query('SELECT id,version,file_version,verification_status,document_status,checksum FROM finance_os.evidence WHERE id=$1 FOR SHARE',[uuid(input.evidence_id)])).rows[0];
 if(!r||r.document_status!=='Active')throw fail('Active canonical evidence is required');
 if(input.evidence_version!==r.version||(input.evidence_file_version??null)!==(r.file_version??null))throw fail('Evidence version changed; reload and review it again',409);
 return r;
}
function evidenceCurrent(r:Row){return !r.evidence_id||(r.current_evidence_version===r.evidence_version&&String(r.current_file_version??'')===String(r.evidence_file_version??'')&&r.evidence_status==='Verified'&&r.document_status==='Active');}
export function itemReady(r:Row){return ['Resolved','Not applicable'].includes(r.status)&&evidenceCurrent(r);}
const itemSelect=`SELECT i.*,i.source_date::text,e.version current_evidence_version,e.file_version current_file_version,e.verification_status evidence_status,e.document_status,e.title evidence_title FROM finance_os.debt_application_items i LEFT JOIN finance_os.evidence e ON e.id=i.evidence_id WHERE i.application_id=$1 ORDER BY i.section,i.code`;
const psbSelect=`SELECT p.*,p.source_date::text,p.period_start::text,p.period_end::text,e.version current_evidence_version,e.file_version current_file_version,e.verification_status evidence_status,e.document_status FROM finance_os.debt_psb_entries p LEFT JOIN finance_os.evidence e ON e.id=p.evidence_id WHERE p.application_id=$1 ORDER BY p.workbook_row`;
export function psbSummary(rows:Row[],payment:number){
 const ready=rows.length===PSB_ROWS.length&&rows.every(r=>['Reviewed','Not applicable'].includes(r.status)&&evidenceCurrent(r));
 const total=(kind:string)=>round(rows.filter(r=>r.kind===kind).reduce((s,r)=>s+(r.status==='Not applicable'?0:Number(r.monthly_amount??0)),0));
 const income=ready?total('income'):null;const expenses=ready?total('expense'):null;
 return {ready,complete:rows.filter(r=>['Reviewed','Not applicable'].includes(r.status)&&evidenceCurrent(r)).length,total:PSB_ROWS.length,
 monthly_income:income,monthly_expenses:expenses,annual_income:ready?round(income!*12):null,annual_expenses:ready?round(expenses!*12):null,monthly_surplus:ready?round(income!-expenses!):null,after_proposed_payment:ready?round(income!-expenses!-payment):null,
 affordability:!ready?'Unknown — complete private PSB':income!-expenses!<payment?'Shortfall — founder review required':'Indicative surplus — lender assessment still required',
 rule:'Ongoing personal net income and expenses for the first month after the loan; do not enter the proposed new loan repayment in existing credit. The indicative repayment is deducted once here. No KLPS/Sovereign income is inferred.'};
}
export function budgetSummary(items:Row[],requested:number){
 const lines=items.filter(r=>r.section==='budget'&&r.status!=='Not applicable'&&r.data.eligibility!=='Ineligible');
 const sum=(rows:Row[])=>round(rows.reduce((s,r)=>s+(r.data.gross==null?0:Number(r.data.gross)),0));
 const allocated=sum(lines);const evidenced=sum(lines.filter(r=>itemReady(r)&&r.data.eligibility==='Confirmed'));
 return {provisional_allocated:allocated,evidenced_eligible:evidenced,unallocated:round(requested-allocated),unknown_cost_lines:lines.filter(r=>r.data.gross==null).length,overallocated:allocated>requested};
}
export async function initialiseDebtApplication(actor:string,db:Db){
 const companies=(await db.query("SELECT id FROM finance_os.company WHERE company_number='16436591'")).rows;
 if(companies.length!==1)throw fail('Canonical company must be resolved first',409);
 const result=await db.query(`INSERT INTO finance_os.debt_applications(company_id,applicant_id,application_key,product,partner,requested_amount,term_months,indicative_rate,rate_source,rate_as_of) VALUES($1,$2,$3,'Start Up Loans','GC Business Finance',7000,60,0.075,$4,'2026-09-23') ON CONFLICT(company_id,applicant_id,application_key) DO NOTHING RETURNING *`,[companies[0].id,actor,TEMPLATE_VERSION,'https://www.startuploans.co.uk/support-and-guidance/frequently-asked-questions/changes-to-interest-rate-and-eligibility']);
 if(!result.rows[0])return (await db.query('SELECT id FROM finance_os.debt_applications WHERE company_id=$1 AND applicant_id=$2 AND application_key=$3',[companies[0].id,actor,TEMPLATE_VERSION])).rows[0];
 const app=result.rows[0];await history(app.id,app.id,'application',1,app,actor,db);
 for(const s of SEEDS){
  const r=(await db.query(`INSERT INTO finance_os.debt_application_items(application_id,code,section,title,application_field,status,data,source,source_date,classification,next_action,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2026-09-23',$9,$10,$11) RETURNING *`,[app.id,s.code,s.section,s.title,s.field,s.status??'Missing',JSON.stringify(validateData(s.section,s.data)),s.source??'Pass 1 audit, 23 September 2026; review against canonical evidence before use',s.classification??'Unknown',s.action,actor])).rows[0];
  await history(app.id,r.id,'item',1,r,actor,db);
 }
 for(const r of PSB_ROWS){
  const entry=(await db.query('INSERT INTO finance_os.debt_psb_entries(application_id,workbook_row,kind,title) VALUES($1,$2,$3,$4) RETURNING *',[app.id,r.row,r.kind,r.title])).rows[0];
  await db.query('INSERT INTO finance_os.debt_psb_history(application_id,entry_id,entry_version,snapshot,actor_id) VALUES($1,$2,1,$3,$4)',[app.id,entry.id,JSON.stringify(entry),actor]);
 }
 return {id:app.id};
}
// A deliberately narrow projection of existing FOS, with no account identifiers or personal intake.
export async function existingPosition(db:Db,now=new Date().toISOString()){
 const accounts=(await db.query('SELECT a.id,a.classification,a.currency,a.status,c.provider_environment FROM finance_os.bank_accounts a JOIN finance_os.bank_connections c ON c.id=a.connection_id')).rows;
 const observations=(await db.query('SELECT id,bank_account_id,metric,value,currency,as_of,review_status,evidence_id FROM finance_os.bank_balance_observations ORDER BY as_of DESC')).rows.map(r=>({...r,as_of:new Date(r.as_of).toISOString()}));
 return {as_of:now,cash:cashAuthority(accounts,observations,now),
 credit_observations:observations.filter(r=>['credit_limit','available_credit','outstanding_debt'].includes(r.metric)).map(({bank_account_id,...r})=>({...r,stale:Date.parse(now)-Date.parse(r.as_of)>86400000,not_cash:true})),
 engagements:(await db.query('SELECT id,provider,budget_ex_vat,price_basis,price_evidence_id,status FROM finance_os.fundraising_engagements')).rows,
 vat:(await db.query('SELECT id,obligation_reference,submitted_at,result,box_4,box_5,box_6 FROM finance_os.vat_filings')).rows,
 expense_control:(await db.query(`SELECT count(*)::integer AS active_records,count(*) FILTER(WHERE founder_paid=true)::integer AS founder_paid_records FROM finance_os.expenses WHERE archived_at IS NULL`)).rows[0],
 warning:'Read-only source observations, not a reconciled current financial statement. Credit availability is not cash; historical VAT is not current revenue; founder-paid expenses are not company cash payments. Resolve the financial checklist before drafting.'};
}
export async function getDebtWorkspace(actor:string,db:Db=pool):Promise<Record<string,any>>{
 if(db===pool){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await getDebtWorkspace(actor,c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 const apps=(await db.query(`SELECT a.*,a.rate_as_of::text,a.forecast_start::text FROM finance_os.debt_applications a JOIN finance_os.company c ON c.id=a.company_id WHERE applicant_id=$1 AND c.company_number='16436591' ORDER BY a.created_at DESC`,[uuid(actor)])).rows;
 const position=await existingPosition(db);
 const results=[];
 for(const app of apps){
  const items=(await db.query(itemSelect,[app.id])).rows.map(r=>({...r,ready:itemReady(r)}));
  const psbRows=(await db.query(psbSelect,[app.id])).rows;const payment=indicativePayment(Number(app.requested_amount),app.term_months,Number(app.indicative_rate));const psb=psbSummary(psbRows,payment.monthly);
  results.push({application:app,items,payment,budget:budgetSummary(items,Number(app.requested_amount)),
   summary:{psb:{ready:psb.ready,complete:psb.complete,total:psb.total},affordability:psb.affordability,
    cash_flow_ready:position.cash.value!==null&&!!app.forecast_start&&items.filter(r=>['forecast','financial'].includes(r.section)||r.code==='forecast-loan').every(r=>r.ready)&&psb.ready,
    complete:items.filter(r=>r.ready).length,total:items.length,blockers:items.filter(r=>!r.ready&&r.section!=='document').map(r=>({code:r.code,title:r.title,next_action:r.next_action,section:r.section})),
    unresolved_contradictions:items.filter(r=>r.section==='reconciliation'&&!r.ready).length,documents_ready:items.filter(r=>r.section==='document'&&!r.code.startsWith('original-')&&r.ready).length,documents_total:items.filter(r=>r.section==='document'&&!r.code.startsWith('original-')).length},
   history:(await db.query('SELECT id,entity_id,entity_kind,entity_version,snapshot,recorded_at FROM finance_os.debt_application_history WHERE application_id=$1 ORDER BY recorded_at DESC,id',[app.id])).rows});
 }
 return {applications:results,fields:FIELDS,statuses:ITEM_STATUSES,classifications:CLASSIFICATIONS,application_statuses:APPLICATION_STATUSES,position,template:{version:TEMPLATE_VERSION,workbook:WORKBOOK,guide:GUIDE}};
}
export async function updateDebtApplication(id:string,input:Input,actor:string,db:Db){
 only(input,['version','requested_amount','term_months','forecast_start','status','reason']);const app=await application(id,actor,db,true);
 if(app.version!==version(input.version))throw fail('Application changed; reload before saving',409);
 const requested=amount(input.requested_amount);if(!requested||requested>25000)throw fail('Requested amount must be between £0.01 and £25,000');
 const term=Number(input.term_months);if(!Number.isInteger(term)||term<12||term>60)throw fail('Term must be 12–60 months');
 const start=date(input.forecast_start);if(start&&!start.endsWith('-01'))throw fail('Forecast start must be first day of month');
 const status=choose(input.status,APPLICATION_STATUSES,'application status');const reason=required(input.reason,'Change reason');
 const row=(await db.query('UPDATE finance_os.debt_applications SET requested_amount=$2,term_months=$3,forecast_start=$4,status=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,requested,term,start,status])).rows[0];
 await history(id,id,'application',row.version,{...row,reason},actor,db);return {id,version:row.version};
}
export async function saveDebtItem(appId:string,itemId:string|null,input:Input,actor:string,db:Db){
 only(input,['version','section','title','application_field','status','data','source','source_date','evidence_id','evidence_version','evidence_file_version','locator','classification','rationale','next_action','owner','review_confirmed']);
 await application(appId,actor,db,true);
 const old=itemId?(await db.query('SELECT * FROM finance_os.debt_application_items WHERE id=$1 AND application_id=$2 FOR UPDATE',[uuid(itemId),appId])).rows[0]:null;
 if(itemId&&!old)throw fail('Item not found',404);
 if(old&&old.version!==version(input.version))throw fail('Item changed; reload before saving',409);
 const section=(old?.section??choose(input.section,['budget'],'new item section')) as Section;
 if(old&&input.section&&input.section!==section)throw fail('Item section cannot change');
 const data=validateData(section,input.data);const status=choose(input.status,ITEM_STATUSES,'item status');const classification=choose(input.classification,CLASSIFICATIONS,'classification');
 const source=optional(input.source),sourceDate=pastDate(input.source_date),rationale=required(input.rationale,'Review/change reason');
 const ev=await linkEvidence(input,db);
 if(old?.code==='original-workbook'||old?.code==='original-guide'){
  if(JSON.stringify(data)!==JSON.stringify(validateData('document',old.data)))throw fail('Original source metadata and defects must be preserved');
  if(ev.id&&ev.checksum!==data.sha256)throw fail('Original source checksum does not match');
 }
 if(section==='budget'&&(!data.description||!data.purpose))throw fail('A business requirement and purpose are required for a budget line');
 if(status==='Resolved'){
  if(input.review_confirmed!==true||!source||!sourceDate||['Unknown','Conflict'].includes(classification))throw fail('Resolution requires explicit review, dated source and a resolved classification');
  if((classification==='Extracted fact'||section==='document'||section==='budget')&&!ev.id)throw fail('Canonical evidence is required for this resolution');
  if(ev.id&&ev.verification_status!=='Verified')throw fail('Resolved items require verified evidence');
  if(section==='forecast'&&(data.cash_direction==='Unresolved'||!data.basis||Array.from({length:12},(_,i)=>data[`m${i+1}`]).some(v=>v==null)))throw fail('Twelve explicit monthly inputs, cash direction and cash timing basis are required');
  if(section==='budget'&&(data.gross==null||data.net==null||data.vat==null||data.quantity==null||!data.supplier||!data.description||!data.purpose||!data.milestone||!data.payment_date||data.eligibility!=='Confirmed'||!data.eligibility_basis))throw fail('Resolved budget needs priced scope, timing, purpose, milestone and confirmed eligibility');
  if(['financial','commercial','requirement'].includes(section)&&!data.finding)throw fail('A substantive finding is required');
  if(section==='reconciliation'&&!data.prospective)throw fail('Prospective wording is required');
 }
 if(status==='Not applicable'&&input.review_confirmed!==true)throw fail('Non-applicability requires explicit founder review and reason');
 const id=old?.id??randomUUID(),v=old?old.version+1:1;
 const params=[id,appId,old?.code??`budget-${id}`,section,required(input.title??old?.title,'Title'),required(input.application_field??old?.application_field,'Application field'),status,JSON.stringify(data),source,sourceDate,ev.id,ev.version,ev.file_version??null,optional(input.locator),classification,rationale,required(input.next_action,'Next action'),required(input.owner??'Founder','Owner'),v,actor];
 const row=(await db.query(`INSERT INTO finance_os.debt_application_items(id,application_id,code,section,title,application_field,status,data,source,source_date,evidence_id,evidence_version,evidence_file_version,locator,classification,rationale,next_action,owner,version,updated_by) VALUES(${params.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,application_field=EXCLUDED.application_field,status=EXCLUDED.status,data=EXCLUDED.data,source=EXCLUDED.source,source_date=EXCLUDED.source_date,evidence_id=EXCLUDED.evidence_id,evidence_version=EXCLUDED.evidence_version,evidence_file_version=EXCLUDED.evidence_file_version,locator=EXCLUDED.locator,classification=EXCLUDED.classification,rationale=EXCLUDED.rationale,next_action=EXCLUDED.next_action,owner=EXCLUDED.owner,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,params)).rows[0];
 await history(appId,id,'item',v,row,actor,db);return {id,version:v};
}
export async function getPrivatePsb(id:string,actor:string,db:Db=pool){
 const app=await application(id,actor,db);const entries=(await db.query(psbSelect,[id])).rows;
 return {entries,summary:psbSummary(entries,indicativePayment(Number(app.requested_amount),app.term_months,Number(app.indicative_rate)).monthly),history:(await db.query('SELECT entry_id,entry_version,snapshot,recorded_at FROM finance_os.debt_psb_history WHERE application_id=$1 ORDER BY recorded_at DESC',[id])).rows};
}
export async function savePrivatePsb(id:string,entryId:string,input:Input,actor:string,db:Db){
 only(input,['version','monthly_amount','status','source','source_date','period_start','period_end','evidence_id','evidence_version','evidence_file_version','locator','rationale','review_confirmed']);
 await application(id,actor,db,true);
 const old=(await db.query('SELECT * FROM finance_os.debt_psb_entries WHERE id=$1 AND application_id=$2 FOR UPDATE',[uuid(entryId),id])).rows[0];
 if(!old)throw fail('PSB entry not found',404);if(old.version!==version(input.version))throw fail('PSB entry changed; reload',409);
 const monthly=amount(input.monthly_amount),status=choose(input.status,['Missing','Provisional','Reviewed','Not applicable'],'PSB status');
 const source=optional(input.source),rationale=required(input.rationale,'Reason'),sourceDate=pastDate(input.source_date),start=pastDate(input.period_start),end=pastDate(input.period_end),locator=optional(input.locator);
 // This intake stores extracted figures and short provenance, never banking secrets/full card data.
 for(const value of [source,rationale,locator])if(value.length>1500||/(?:\d[ -]?){12,19}|\b(?:password|pin|cvv|cvc|iban|account number|sort code)\s*[:=]/i.test(value))throw fail('Use short provenance notes only; do not enter credentials, card/account numbers or credit-report details');
 if(start&&end&&end<start)throw fail('Evidence period end precedes start');
 const ev=await linkEvidence(input,db);
 if(status==='Reviewed'&&(input.review_confirmed!==true||monthly===null||!source||!sourceDate||!start||!end))throw fail('Reviewed PSB figures require amount, source/date, evidence period and explicit confirmation');
 if(status==='Reviewed'&&ev.id&&ev.verification_status!=='Verified')throw fail('Linked PSB evidence must be verified before review');
 if(status==='Not applicable'&&(monthly!==null||input.review_confirmed!==true))throw fail('Non-applicable entries require a blank amount, explicit confirmation and reason');
 const row=(await db.query(`UPDATE finance_os.debt_psb_entries SET monthly_amount=$3,status=$4,source=$5,source_date=$6,period_start=$7,period_end=$8,evidence_id=$9,evidence_version=$10,evidence_file_version=$11,locator=$12,rationale=$13,version=version+1,updated_at=now() WHERE id=$1 AND application_id=$2 RETURNING *`,[entryId,id,monthly,status,source,sourceDate,start,end,ev.id,ev.version,ev.file_version??null,locator,rationale])).rows[0];
 await db.query('INSERT INTO finance_os.debt_psb_history(application_id,entry_id,entry_version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)',[id,entryId,row.version,JSON.stringify(row),actor]);return {id:entryId,version:row.version};
}
export async function addDebtInteraction(id:string,input:Input,actor:string,db:Db){
 only(input,['kind','description','source','occurred_on','evidence_id','evidence_version','evidence_file_version']);await application(id,actor,db,true);
 const kind=choose(input.kind,['adviser interaction','founder review','evidence request','decision note'],'interaction kind');const ev=await linkEvidence(input,db);
 if(ev.id)await db.query('UPDATE finance_os.evidence SET founder_only=true WHERE id=$1',[ev.id]);
 const event=randomUUID();await history(id,event,'interaction',1,{kind,description:required(input.description,'Description'),source:required(input.source,'Source'),occurred_on:pastDate(input.occurred_on),evidence_id:ev.id,evidence_version:ev.version,file_version:ev.file_version??null,decision_effect:'Preparation note only; no submission, financing decision or accounting effect'},actor,db);return {id:event};
}
export async function recordDebtReview(id:string,input:Input,actor:string,db:Db){
 only(input,['reason','review_confirmed']);const app=await application(id,actor,db,true);if(input.review_confirmed!==true)throw fail('Explicit founder review is required');
 const items=(await db.query(itemSelect,[id])).rows;const psb=(await db.query(psbSelect,[id])).rows;
 const review=randomUUID();await history(id,review,'review',1,{reason:required(input.reason,'Review reason'),status:'Internal review only — not submitted',application_version:app.version,template_version:TEMPLATE_VERSION,items:items.map(r=>({id:r.id,version:r.version,ready:itemReady(r),evidence_id:r.evidence_id,evidence_version:r.evidence_version,file_version:r.evidence_file_version})),private_psb_versions:psb.map(r=>({id:r.id,version:r.version})),budget:budgetSummary(items,Number(app.requested_amount)),position:await existingPosition(db)},actor,db);return {id:review};
}
