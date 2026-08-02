import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db=Pick<PoolClient,"query">;
type Input=Record<string,unknown>;
const vatError=(message:string,code="invalid_vat_expense",statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const text=(v:unknown)=>typeof v==="string"&&v.trim()?v.trim():null;
const date=(v:unknown)=>{const x=text(v);if(!x)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(x)||Number.isNaN(Date.parse(`${x}T00:00:00Z`)))throw vatError("Invalid date");return x;};
const decimal=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const x=String(v);if(!/^\d+(\.\d{1,8})?$/.test(x))throw vatError("Invalid non-negative decimal");return x;};
const bool=(v:unknown)=>typeof v==="boolean"?v:null;
const uuid=(v:unknown)=>{const x=text(v);if(!x||!/^[-0-9a-f]{36}$/i.test(x))throw vatError("Invalid identifier");return x;};
export const VAT_TREATMENTS=["standard_rated","reduced_rated","zero_rated","exempt","outside_scope","no_vat_shown","reverse_charge_review_required","import_vat_review_required","blocked_vat","partially_recoverable","personal_non_business","pending_review"] as const;
const REVIEW=["pending_review","in_review","ready_for_review","review_complete"];
const optionalEnum=(v:unknown,values:readonly string[])=>{const x=text(v);if(x&&!values.includes(x))throw vatError("Invalid controlled value");return x;};

export const expenseWarnings=(row:Input)=>{
  const warnings:string[]=[];
  const net=Number(row.gbp_net_amount??row.net_amount),vat=Number(row.gbp_vat_amount??row.vat_amount),gross=Number(row.gbp_gross_amount??row.gross_amount);
  if([net,vat,gross].every(Number.isFinite)&&Math.abs(net+vat-gross)>0.01)warnings.push("gross_net_vat_mismatch");
  if(row.currency&&row.currency!=="GBP"&&!row.exchange_rate)warnings.push("foreign_currency_without_conversion");
  if(!row.supplier_country)warnings.push("supplier_country_missing");
  if(Number(row.recoverable_vat_amount)>0&&!row.supplier_vat_number)warnings.push("supplier_vat_number_missing");
  if(row.vat_treatment==="reverse_charge_review_required")warnings.push("reverse_charge_review_required");
  if(row.business_use_percentage!==null&&row.business_use_percentage!==undefined&&Number(row.business_use_percentage)<1)warnings.push("personal_mixed_use_review_required");
  return warnings;
};

const expenseValues=(input:Input,partial=false)=>{
  const values:Input={};
  const dates=["transaction_date","invoice_date","payment_date"];
  const decimals=["net_amount","vat_amount","gross_amount","vat_rate","exchange_rate","gbp_net_amount","gbp_vat_amount","gbp_gross_amount","business_use_percentage","recoverable_vat_amount"];
  const texts=["name","supplier_name","description","category","currency","supplier_country","supplier_vat_number","invoice_number","order_reference","payment_method","payment_source","reimbursement_status","vat_override_reason","notes"];
  for(const f of dates)if(f in input)values[f]=date(input[f]);
  for(const f of decimals)if(f in input)values[f]=decimal(input[f]);
  for(const f of texts)if(f in input)values[f]=text(input[f]);
  if("founder_paid" in input)values.founder_paid=bool(input.founder_paid);
  if("vat_period_id" in input)values.vat_period_id=input.vat_period_id?uuid(input.vat_period_id):null;
  if("vat_treatment" in input)values.vat_treatment=optionalEnum(input.vat_treatment,VAT_TREATMENTS);
  if("vat_review_status" in input)values.vat_review_status=optionalEnum(input.vat_review_status,REVIEW);
  if(!partial){
    values.supplier_name=text(input.supplier_name);
    values.category=text(input.category)??"To Classify";
    values.currency=text(input.currency)??"GBP";
    values.transaction_date=date(input.transaction_date??input.payment_date);
    if(!values.supplier_name||!values.transaction_date||decimal(input.gross_amount)===null)throw vatError("Payment date, supplier and gross amount are required");
    values.gross_amount=decimal(input.gross_amount);
  }
  return values;
};

export const listVatPeriods=async(db:Db=pool)=>(await db.query("SELECT * FROM finance_os.vat_periods ORDER BY start_date")).rows;
export const suggestVatPeriod=async(value:unknown,db:Db=pool)=>{
  const taxPoint=date(value);if(!taxPoint)return null;
  return (await db.query("SELECT * FROM finance_os.vat_periods WHERE $1::date BETWEEN start_date AND end_date ORDER BY start_date LIMIT 1",[taxPoint])).rows[0]??null;
};
export const createHistoricalExpense=async(input:Input,userId:string,db:Db=pool)=>{
  const value=expenseValues(input); const key=`manual-${value.transaction_date}-${crypto.randomUUID()}`;
  const name=text(input.name)??[value.supplier_name,value.transaction_date,text(input.description)].filter(Boolean).join(" · ").slice(0,255);
  const fields=Object.keys(value); const params=fields.map(f=>value[f]);
  const result=await db.query(`INSERT INTO finance_os.expenses(import_key,name,cost_type,current_status,evidence_status,change_reason,created_by,updated_by,${fields.join(",")}) VALUES($1,$2,'Actual transaction','Pending Review','To Evidence',$3,$4,$4,${fields.map((_,i)=>`$${i+5}`).join(",")}) RETURNING *`,[key,name,text(input.change_reason)??"Created historical expense",userId,...params]);
  return {...result.rows[0],warnings:expenseWarnings(result.rows[0])};
};
export const updateHistoricalExpense=async(id:string,input:Input,userId:string,db:Db=pool)=>{
  const value=expenseValues(input,true);const fields=Object.keys(value);if(!fields.length)throw vatError("No expense fields supplied");
  const reason=text(input.change_reason);if(!reason)throw vatError("change_reason is required");
  const params=fields.map(f=>value[f]);
  const result=await db.query(`UPDATE finance_os.expenses SET ${fields.map((f,i)=>`${f}=$${i+1}`).join(",")},updated_by=$${fields.length+1},change_reason=$${fields.length+2} WHERE id=$${fields.length+3} RETURNING *`,[...params,userId,reason,uuid(id)]);
  if(!result.rows[0])throw vatError("Expense not found","expense_not_found",404);
  const warnings=expenseWarnings(result.rows[0]);
  if(value.vat_review_status==="review_complete"&&warnings.length)throw vatError("Critical warnings must be resolved","vat_review_blocked",409);
  return {...result.rows[0],warnings};
};
export const archiveHistoricalExpense=async(id:string,reason:unknown,userId:string,db:Db=pool)=>{
  const why=text(reason);if(!why)throw vatError("change_reason is required");
  const result=await db.query("UPDATE finance_os.expenses SET archived_at=now(),archived_by=$1,updated_by=$1,change_reason=$2 WHERE id=$3 RETURNING *",[userId,why,uuid(id)]);
  if(!result.rows[0])throw vatError("Expense not found","expense_not_found",404);return result.rows[0];
};
export const createExpenseAdjustment=async(expenseId:string,input:Input,userId:string,db:Db=pool)=>{
  const types=["supplier_refund","partial_refund","full_refund","credit_note","correction","chargeback","other_adjustment"];
  const type=optionalEnum(input.adjustment_type,types);const adjustmentDate=date(input.adjustment_date);const reason=text(input.reason);
  if(!type||!adjustmentDate||!reason)throw vatError("Adjustment type, date and reason are required");
  const result=await db.query(`INSERT INTO finance_os.expense_adjustments(expense_id,adjustment_type,adjustment_date,net_amount,vat_amount,gross_amount,currency,gbp_net_amount,gbp_vat_amount,gbp_gross_amount,reason,supplier_reference,review_status,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,[uuid(expenseId),type,adjustmentDate,decimal(input.net_amount),decimal(input.vat_amount),decimal(input.gross_amount),text(input.currency)??"GBP",decimal(input.gbp_net_amount),decimal(input.gbp_vat_amount),decimal(input.gbp_gross_amount),reason,text(input.supplier_reference),optionalEnum(input.review_status,REVIEW)??"pending_review",userId]);return result.rows[0];
};
export const getVatLedger=async(periodId:unknown,db:Db=pool)=>{
  const result=await db.query(`SELECT e.*,p.start_date AS vat_period_start,p.end_date AS vat_period_end,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ev.id,'filename',ev.original_filename,'type',ev.vat_evidence_type)) FROM finance_os.evidence_links l JOIN finance_os.evidence ev ON ev.id=l.evidence_id WHERE l.entity_type='expense' AND l.entity_id=e.id),'[]'::jsonb) evidence_files
    FROM finance_os.expenses e LEFT JOIN finance_os.vat_periods p ON p.id=e.vat_period_id WHERE e.archived_at IS NULL AND ($1::uuid IS NULL OR e.vat_period_id=$1) ORDER BY COALESCE(e.transaction_date,e.payment_date),e.created_at`,[periodId?uuid(periodId):null]);
  const duplicateKeys=new Map<string,number>();
  for(const row of result.rows){const key=[row.supplier_name,row.transaction_date??row.payment_date,row.gross_amount].join("|");duplicateKeys.set(key,(duplicateKeys.get(key)??0)+1);}
  return result.rows.map(row=>{
    const files=Array.isArray(row.evidence_files)?row.evidence_files:[];
    const types=files.map((f:{type?:unknown})=>String(f.type??""));
    const supplier=types.some((t:string)=>["full_vat_invoice","simplified_vat_invoice","retail_receipt","supplier_invoice_no_vat","credit_note"].includes(t));
    const payment=types.some((t:string)=>["paypal_payment_receipt","card_bank_statement","proof_of_payment"].includes(t));
    const vatInvoice=types.some((t:string)=>["full_vat_invoice","simplified_vat_invoice"].includes(t));
    const adjustment=types.some((t:string)=>["credit_note","refund_confirmation"].includes(t));
    const coverage=adjustment?"refund_or_credit_adjustment_present":vatInvoice?"vat_invoice_present":supplier&&payment?"supplier_document_plus_payment_evidence":supplier?"supplier_document_only":payment?"payment_evidence_only":files.length?"requires_review":"no_evidence";
    const warnings=expenseWarnings(row);
    if(!supplier)warnings.push("no_supplier_invoice");if(!payment)warnings.push("payment_evidence_missing");
    const key=[row.supplier_name,row.transaction_date??row.payment_date,row.gross_amount].join("|");if((duplicateKeys.get(key)??0)>1)warnings.push("possible_duplicate");
    return {...row,evidence_coverage:coverage,warnings};
  });
};
export const createComplianceDocument=async(input:Input,userId:string,db:Db=pool)=>{
  const types=["hmrc_vat_registration_notice","hmrc_vat_assessment","hmrc_debt_management_letter","annual_accounting_scheme_correspondence","vat_liability_statement","penalty_notice","hmrc_general_correspondence","other_compliance_document"];
  const type=optionalEnum(input.compliance_type,types);if(!type)throw vatError("compliance_type is required");
  const result=await db.query(`INSERT INTO finance_os.compliance_documents(evidence_id,compliance_type,company_id,vat_period_id,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uuid(input.evidence_id),type,uuid(input.company_id),input.vat_period_id?uuid(input.vat_period_id):null,text(input.notes),userId]);return result.rows[0];
};
export const listComplianceDocuments=async(db:Db=pool)=>(await db.query(`SELECT c.*,e.title,e.original_filename,e.document_date,e.created_at AS uploaded_at FROM finance_os.compliance_documents c JOIN finance_os.evidence e ON e.id=c.evidence_id ORDER BY e.document_date DESC NULLS LAST,c.created_at DESC`)).rows;
