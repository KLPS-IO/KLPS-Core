import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { getVatLedger,resolvePaymentSource } from "./finance-vat.service";

type Db=Pick<PoolClient,"query">;
type Row=Record<string,unknown>;
export type ReadinessState="SUBMITTED"|"OVERDUE"|"BLOCKED"|"READY_TO_EXPORT"|"EXPORTED_NOT_FILED"|"IN_REVIEW"|"UPCOMING";
export type FinanceActionCandidate={action_type:string;entity_type:string;entity_id:string|null;title:string;description:string;priority:"low"|"normal"|"high"|"critical";due_date:string|null;recommended_start_date:string|null;is_machine_verifiable:boolean;dedupe_key:string;deep_link:string|null;metadata:Row};
export interface FutureBankReconciliationActionProvider{getCandidates():Promise<FinanceActionCandidate[]>}

const day=(value:unknown)=>typeof value==="string"?value.slice(0,10):value instanceof Date?value.toISOString().slice(0,10):null;
export const daysUntil=(target:string,today:string)=>Math.round((Date.parse(`${target}T00:00:00Z`)-Date.parse(`${today}T00:00:00Z`))/86400000);
export const REMINDER_DAYS=[30,21,14,10,7,3,1,0] as const;
export const reminderState=(deadline:string,today:string)=>{const remaining=daysUntil(deadline,today);return{days_remaining:remaining,milestone:remaining<0?"overdue":REMINDER_DAYS.includes(remaining as typeof REMINDER_DAYS[number])?remaining:null};};
export const readinessState=(input:{filed:boolean;deadline:string;today:string;blockers:number;validated:boolean;exported:boolean;started:boolean}):ReadinessState=>{
  if(input.filed)return"SUBMITTED";
  if(daysUntil(input.deadline,input.today)<0)return"OVERDUE";
  if(input.blockers>0)return"BLOCKED";
  if(input.exported)return"EXPORTED_NOT_FILED";
  if(input.validated)return"READY_TO_EXPORT";
  if(input.started)return"IN_REVIEW";
  return"UPCOMING";
};
const minusDays=(date:string,count:number)=>new Date(Date.parse(`${date}T00:00:00Z`)-count*86400000).toISOString().slice(0,10);

export const derivePeriodActions=(period:Row):FinanceActionCandidate[]=>{
  if(period.readiness_state==="SUBMITTED")return[];
  const id=String(period.id),deadline=String(period.filing_deadline);
  const link=`/data-room/finance/vat-ledger?period=${id}`;
  const common=(type:string,title:string,offset:number,machine:boolean,priority:FinanceActionCandidate["priority"]="normal"):FinanceActionCandidate=>({action_type:type,entity_type:"vat_period",entity_id:id,title,description:`VAT period ${period.start_date} to ${period.end_date}`,priority,due_date:deadline,recommended_start_date:minusDays(deadline,offset),is_machine_verifiable:machine,dedupe_key:`vat-period:${id}:${type}`,deep_link:link,metadata:{vat_period_id:id}});
  const actions=[common("begin_review","Begin VAT period review",30,true),common("review_evidence","Review VAT evidence",21,true),common("complete_classification","Complete expense classification",14,true),common("validate_mtd_export","Validate MTD accounting export",10,true,"high")];
  if(Number(period.blocker_count)>0)actions.push(common("clear_validation_blockers","Clear VAT validation blockers",7,true,"critical"));
  if(period.readiness_state==="READY_TO_EXPORT")actions.push(common("generate_accounting_export","Generate accounting export",7,true,"high"));
  if(period.readiness_state==="EXPORTED_NOT_FILED")actions.push(common("quickfile_reconciliation","Reconcile QuickFile return",3,false,"high"),common("founder_final_review","Complete founder final review",1,false,"high"));
  actions.push(common("confirm_vat_filing","Record VAT filing confirmation",0,false,period.readiness_state==="OVERDUE"?"critical":"high"));
  return actions;
};

export const deriveExpenseActions=(rows:Row[]):FinanceActionCandidate[]=>rows.flatMap(row=>{
  const id=String(row.id),period=String(row.effective_vat_period_id??row.stored_vat_period_id??"");
  const link=`/data-room/finance/vat-ledger?${period?`period=${period}&`:""}expense=${id}`;
  const action=(type:string,title:string,machine:boolean,priority:FinanceActionCandidate["priority"]="high"):FinanceActionCandidate=>({action_type:type,entity_type:"expense",entity_id:id,title,description:String(row.supplier_name??row.name??"Expense requires review"),priority,due_date:null,recommended_start_date:null,is_machine_verifiable:machine,dedupe_key:`expense:${id}:${type}`,deep_link:link,metadata:{expense_id:id,vat_period_id:period||null}});
  const result:FinanceActionCandidate[]=[];
  if(String(row.category??"")==="To Classify")result.push(action("classify_expense","Classify expense",true));
  if(resolvePaymentSource(row)==="unresolved")result.push(action("resolve_payment_source","Resolve payment source",true));
  if(!Array.isArray(row.evidence_files)||row.evidence_files.length===0)result.push(action("link_evidence","Link expense evidence",true));
  if(Array.isArray(row.warnings)&&row.warnings.includes("vat_period_date_conflict"))result.push(action("resolve_vat_period_conflict","Review VAT period conflict",true,"critical"));
  if(String(row.supplier_document_review_status??"pending_review")==="pending_review")result.push(action("supplier_document_judgement","Review supplier document",false));
  return result;
});

export const getFinanceCompliance=async(now=new Date(),db:Db=pool)=>{
  const today=now.toISOString().slice(0,10);
  const periods=(await db.query(`SELECT p.*,p.start_date::text,p.end_date::text,p.filing_deadline::text,
    EXISTS(SELECT 1 FROM finance_os.vat_filings f WHERE f.vat_period_id=p.id) filed,
    COALESCE((SELECT (e.metadata->>'blocked_row_count')::int FROM finance_os.finance_events e WHERE e.entity_type='vat_period' AND e.entity_id=p.id AND e.event_type IN ('accounting_export_validated','accounting_export_blocked') ORDER BY e.created_at DESC LIMIT 1),0) blocker_count,
    EXISTS(SELECT 1 FROM finance_os.finance_events e WHERE e.entity_type='vat_period' AND e.entity_id=p.id AND e.event_type='accounting_export_validated') validated,
    EXISTS(SELECT 1 FROM finance_os.finance_events e WHERE e.entity_type='vat_period' AND e.entity_id=p.id AND e.event_type IN ('accounting_export_generated','accounting_export_downloaded')) exported,
    EXISTS(SELECT 1 FROM finance_os.expenses x WHERE x.archived_at IS NULL AND x.vat_period_id=p.id) started
    FROM finance_os.vat_periods p ORDER BY p.start_date`)).rows as Row[];
  const enriched=periods.map(period=>{const filingDeadline=day(period.filing_deadline)!;const state=readinessState({filed:Boolean(period.filed),deadline:filingDeadline,today,blockers:Number(period.blocker_count),validated:Boolean(period.validated),exported:Boolean(period.exported),started:Boolean(period.started)});return{...period,readiness_state:state,reminder:reminderState(filingDeadline,today)};});
  const primary=enriched.find(period=>period.readiness_state!=="SUBMITTED")??null;
  const actions=(await db.query(`SELECT * FROM finance_os.finance_actions WHERE status IN ('open','in_progress','waiting') ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,due_date NULLS LAST,created_at LIMIT 100`)).rows;
  return{as_of:today,primary_period:primary,periods:enriched,actions};
};

export const refreshFinanceActions=async(userId:string,now=new Date(),db:Db=pool)=>{
  const overview=await getFinanceCompliance(now,db);
  const ledger=await getVatLedger(undefined,db);
  const candidates=[...overview.periods.flatMap(derivePeriodActions),...deriveExpenseActions(ledger)];
  const client=db===pool?await pool.connect():null;
  const runner:Db=client??db;
  const summary={created:0,updated:0,completed:0,unchanged:0};
  try{
    if(db===pool)await runner.query("BEGIN");
    const existing=(await runner.query("SELECT * FROM finance_os.finance_actions WHERE is_system_generated=true FOR UPDATE")).rows as Row[];
    const byKey=new Map(existing.map(row=>[String(row.dedupe_key),row]));
    const activeKeys=new Set(candidates.map(candidate=>candidate.dedupe_key));
    for(const candidate of candidates){const prior=byKey.get(candidate.dedupe_key);if(!prior){await runner.query(`INSERT INTO finance_os.finance_actions(action_type,entity_type,entity_id,title,description,priority,due_date,recommended_start_date,is_machine_verifiable,dedupe_key,deep_link,metadata,created_by,updated_by,change_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'System refresh created action')`,[candidate.action_type,candidate.entity_type,candidate.entity_id,candidate.title,candidate.description,candidate.priority,candidate.due_date,candidate.recommended_start_date,candidate.is_machine_verifiable,candidate.dedupe_key,candidate.deep_link,candidate.metadata,userId]);summary.created++;continue;}const changed=["title","description","priority","due_date","recommended_start_date","deep_link"].some(key=>String(prior[key]??"")!==String(candidate[key as keyof FinanceActionCandidate]??""));if(changed){await runner.query(`UPDATE finance_os.finance_actions SET title=$1,description=$2,priority=$3,due_date=$4,recommended_start_date=$5,deep_link=$6,metadata=$7,updated_by=$8,change_reason='System refresh updated verifiable fields' WHERE id=$9`,[candidate.title,candidate.description,candidate.priority,candidate.due_date,candidate.recommended_start_date,candidate.deep_link,candidate.metadata,userId,prior.id]);summary.updated++;}else summary.unchanged++;}
    for(const action of existing){if(!activeKeys.has(String(action.dedupe_key))&&action.is_machine_verifiable===true&&!['completed','dismissed'].includes(String(action.status))){await runner.query(`UPDATE finance_os.finance_actions SET status='completed',completed_at=now(),completed_by=$1,updated_by=$1,change_reason='Underlying machine-verifiable condition cleared' WHERE id=$2`,[userId,action.id]);summary.completed++;}}
    await runner.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,summary,metadata,created_by) VALUES('finance_actions_refreshed','finance_actions','Finance actions refreshed',$1,$2)`,[summary,userId]);
    if(db===pool)await runner.query("COMMIT");return summary;
  }catch(error){if(client)await runner.query("ROLLBACK");throw error;}finally{client?.release();}
};

export const listFinanceActions=async(db:Db=pool)=>(await db.query("SELECT * FROM finance_os.finance_actions ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,due_date NULLS LAST,created_at")).rows;
export const updateFinanceAction=async(id:string,status:string,reason:string,userId:string,db:Db=pool)=>{if(!['open','in_progress','waiting','completed','dismissed'].includes(status))throw Object.assign(new Error('Invalid action status'),{statusCode:400});const result=await db.query(`UPDATE finance_os.finance_actions SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END,completed_by=CASE WHEN $1='completed' THEN $2::uuid ELSE NULL END,updated_by=$2,change_reason=$3 WHERE id=$4 RETURNING *`,[status,userId,reason,id]);if(!result.rows[0])throw Object.assign(new Error('Finance action not found'),{statusCode:404});await db.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES('finance_action_status_changed','finance_action',$1,'Finance action status changed',jsonb_build_object('status',$2),$3)`,[id,status,userId]);return result.rows[0];};

export const listVatFilings=async(db:Db=pool)=>(await db.query(`SELECT f.id,f.vat_period_id,f.obligation_reference,f.submitted_at,f.submission_method,f.result,f.box_1,f.box_2,f.box_3,f.box_4,f.box_5,f.box_6,f.box_7,f.box_8,f.box_9,f.source_ledger_fingerprint,f.notes,f.created_at,f.created_by,true AS hmrc_receipt_recorded,p.start_date::text,p.end_date::text,p.filing_deadline::text,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'evidence_code',e.evidence_code,'title',e.title,'description',e.description,'source_organisation',e.source_organisation,'document_date',e.document_date,'filing_evidence_purpose',e.filing_evidence_purpose,'original_filename',e.original_filename,'mime_type',e.mime_type,'file_size',e.file_size,'has_r2_object',e.r2_object_key IS NOT NULL,'document_status',e.document_status,'verification_status',e.verification_status,'link_id',l.id) ORDER BY l.created_at) FROM finance_os.evidence_links l JOIN finance_os.evidence e ON e.id=l.evidence_id WHERE l.entity_type='vat_filing' AND l.entity_id=f.id AND l.hidden=false),'[]'::jsonb) evidence
  FROM finance_os.vat_filings f JOIN finance_os.vat_periods p ON p.id=f.vat_period_id ORDER BY f.submitted_at DESC`)).rows;
export const auditVatFilingEvidence=async(eventType:"vat_filing_evidence_linked"|"vat_filing_evidence_unlinked",filingId:string,evidenceId:string,purpose:string,userId:string,db:Db=pool)=>{
  const filing=(await db.query(`SELECT id,vat_period_id,obligation_reference FROM finance_os.vat_filings WHERE id=$1`,[filingId])).rows[0];
  if(!filing)throw Object.assign(new Error("VAT filing not found"),{statusCode:404,code:"linked_entity_not_found"});
  await db.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES($1,'vat_filing',$2,$3,jsonb_build_object('vat_filing_id',$2::text,'vat_period_id',$4::text,'obligation_reference',$5::text,'evidence_id',$6::text,'evidence_purpose',$7::text,'actor',$8::text,'timestamp',now()),$8)`,[eventType,filing.id,eventType==="vat_filing_evidence_linked"?"VAT filing evidence linked":"VAT filing evidence unlinked",filing.vat_period_id,filing.obligation_reference,evidenceId,purpose,userId]);
};
export const createVatFiling=async(input:Row,userId:string,db:Db=pool)=>{
  const required=['vat_period_id','obligation_reference','submitted_at','submission_method','result','hmrc_receipt_id',...Array.from({length:9},(_,i)=>`box_${i+1}`)];
  for(const field of required)if(input[field]===null||input[field]===undefined||input[field]==='')throw Object.assign(new Error(`${field} is required`),{statusCode:400});
  if(!['delivered','accepted','delivered_accepted'].includes(String(input.result)))throw Object.assign(new Error('Invalid filing result'),{statusCode:400});
  const values=required.map(key=>input[key]);const client=db===pool?await pool.connect():null;const runner:Db=client??db;
  try{
    if(client)await runner.query('BEGIN');
    const result=await runner.query(`INSERT INTO finance_os.vat_filings(vat_period_id,obligation_reference,submitted_at,submission_method,result,hmrc_receipt_id,box_1,box_2,box_3,box_4,box_5,box_6,box_7,box_8,box_9,source_ledger_fingerprint,notes,created_by) VALUES(${Array.from({length:18},(_,i)=>`$${i+1}`).join(',')}) RETURNING id,vat_period_id,obligation_reference,submitted_at,submission_method,result,box_1,box_2,box_3,box_4,box_5,box_6,box_7,box_8,box_9,source_ledger_fingerprint,notes,created_at,created_by,true AS hmrc_receipt_recorded`,[...values,input.source_ledger_fingerprint??null,input.notes??null,userId]);
    await runner.query(`UPDATE finance_os.finance_actions SET status='completed',completed_at=now(),completed_by=$1,updated_by=$1,change_reason='Founder recorded immutable VAT filing' WHERE dedupe_key=$2 AND status NOT IN ('completed','dismissed')`,[userId,`vat-period:${input.vat_period_id}:confirm_vat_filing`]);
    await runner.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES('vat_filing_recorded','vat_filing',$1,'VAT filing recorded',jsonb_build_object('vat_period_id',$2::text,'obligation_reference',$3::text,'result',$4::text),$5)`,[result.rows[0].id,input.vat_period_id,input.obligation_reference,input.result,userId]);
    if(client)await runner.query('COMMIT');return result.rows[0];
  }catch(error){if(client)await runner.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw Object.assign(new Error('A filing already exists for this period or obligation'),{statusCode:409,code:'vat_filing_exists'});throw error;}finally{client?.release();}
};
