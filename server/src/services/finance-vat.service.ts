import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db=Pick<PoolClient,"query">;
type Input=Record<string,unknown>;
type VatPeriod=Input&{id:string;start_date:unknown;end_date:unknown};
type VatLedgerAdjustment=Input&{evidence_files:Input[]};
export type VatPeriodSource="explicit"|"derived"|"none"|"conflict";
export type VatPeriodResolution={stored_vat_period_id:string|null;effective_vat_period_id:string|null;vat_period_source:VatPeriodSource;effective_tax_point_date:string|null;matching_period_ids:string[]};
export type VatWarningSeverity="critical"|"review_required"|"advisory";
export type VatValidationIssue={code:string;severity:VatWarningSeverity;message:string};
const vatError=(message:string,code="invalid_vat_expense",statusCode=400,details?:unknown)=>Object.assign(new Error(message),{code,statusCode,details});
const text=(v:unknown)=>typeof v==="string"&&v.trim()?v.trim():null;
const date=(v:unknown)=>{const x=text(v);if(!x)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(x)||Number.isNaN(Date.parse(`${x}T00:00:00Z`)))throw vatError("Invalid date");return x;};
const decimal=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const x=String(v);if(!/^\d+(\.\d{1,8})?$/.test(x))throw vatError("Invalid non-negative decimal");return x;};
const bool=(v:unknown)=>typeof v==="boolean"?v:null;
const uuid=(v:unknown)=>{const x=text(v);if(!x||!/^[-0-9a-f]{36}$/i.test(x))throw vatError("Invalid identifier");return x;};
export const VAT_TREATMENTS=["standard_rated","reduced_rated","zero_rated","exempt","outside_scope","no_vat_shown","reverse_charge_review_required","import_vat_review_required","blocked_vat","partially_recoverable","personal_non_business","pending_review"] as const;
const REVIEW=["pending_review","in_review","ready_for_review","review_complete"];
const optionalEnum=(v:unknown,values:readonly string[])=>{const x=text(v);if(x&&!values.includes(x))throw vatError("Invalid controlled value");return x;};
const dateOnly=(value:unknown)=>{
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value!=="string")return null;
  const candidate=value.trim().slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate)&&!Number.isNaN(Date.parse(`${candidate}T00:00:00Z`))?candidate:null;
};
const optionalVatStrings=["name","supplier_name","description","category","currency","supplier_country","supplier_vat_number","invoice_number","order_reference","payment_method","payment_source","reimbursement_status","vat_treatment","vat_review_status","evidence_coverage","notes"] as const;
const objectArray=(value:unknown):Input[]=>Array.isArray(value)?value.filter((item):item is Input=>Boolean(item)&&typeof item==="object"&&!Array.isArray(item)):[];
const vatContractDiagnostic=(row:Input,fields:string[])=>{
  if(process.env.NODE_ENV!=="production"&&fields.length)console.warn("VAT ledger record normalized",{record_id:typeof row.id==="string"?row.id:"unknown",fields});
};
export const normalizeVatLedgerRow=(row:Input):Input&{evidence_files:Input[];adjustments:VatLedgerAdjustment[];warnings:string[]}=>{
  const malformed:string[]=[];
  if(!Array.isArray(row.evidence_files))malformed.push("evidence_files");
  if(!Array.isArray(row.adjustments))malformed.push("adjustments");
  if(!Array.isArray(row.warnings))malformed.push("warnings");
  const evidenceFiles=objectArray(row.evidence_files);
  const adjustments=objectArray(row.adjustments).map((adjustment,index)=>{
    if(!Array.isArray(adjustment.evidence_files))malformed.push(`adjustments[${index}].evidence_files`);
    return{...adjustment,evidence_files:objectArray(adjustment.evidence_files)};
  });
  const normalized:Input={...row};
  for(const field of optionalVatStrings)if(normalized[field]===undefined)normalized[field]=null;
  vatContractDiagnostic(row,malformed);
  return{...normalized,evidence_files:evidenceFiles,adjustments,warnings:Array.isArray(row.warnings)?row.warnings.filter((item):item is string=>typeof item==="string"):[]};
};

export const resolveVatPeriod=(expense:Input,periods:VatPeriod[]):VatPeriodResolution=>{
  const stored=text(expense.vat_period_id);
  const taxPoint=dateOnly(expense.invoice_date)??dateOnly(expense.transaction_date)??dateOnly(expense.payment_date);
  if(stored&&periods.some(period=>period.id===stored))return{stored_vat_period_id:stored,effective_vat_period_id:stored,vat_period_source:"explicit",effective_tax_point_date:taxPoint,matching_period_ids:[stored]};
  if(!taxPoint)return{stored_vat_period_id:stored,effective_vat_period_id:null,vat_period_source:"none",effective_tax_point_date:null,matching_period_ids:[]};
  const matches=periods.filter(period=>{const start=dateOnly(period.start_date),end=dateOnly(period.end_date);return Boolean(start&&end&&start<=taxPoint&&taxPoint<=end);});
  if(matches.length===1)return{stored_vat_period_id:stored,effective_vat_period_id:matches[0].id,vat_period_source:"derived",effective_tax_point_date:taxPoint,matching_period_ids:[matches[0].id]};
  return{stored_vat_period_id:stored,effective_vat_period_id:null,vat_period_source:matches.length>1?"conflict":"none",effective_tax_point_date:taxPoint,matching_period_ids:matches.map(period=>period.id)};
};

export const expenseWarnings=(row:Input)=>{
  const warnings:string[]=[];
  const finitePresent=(value:unknown)=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));
  const netValue=row.gbp_net_amount??row.net_amount,vatValue=row.gbp_vat_amount??row.vat_amount,grossValue=row.gbp_gross_amount??row.gross_amount;
  if([netValue,vatValue,grossValue].every(finitePresent)&&Math.abs(Number(netValue)+Number(vatValue)-Number(grossValue))>0.01)warnings.push("gross_net_vat_mismatch");
  const currency=text(row.currency)?.toUpperCase();
  const completeGbp=[row.gbp_net_amount,row.gbp_vat_amount,row.gbp_gross_amount].every(finitePresent);
  const balancedGbp=completeGbp&&Math.abs(Number(row.gbp_net_amount)+Number(row.gbp_vat_amount)-Number(row.gbp_gross_amount))<=0.01;
  const hasRate=Number(row.exchange_rate)>0&&Number.isFinite(Number(row.exchange_rate))&&finitePresent(row.gross_amount)&&completeGbp;
  const hasManualGbp=balancedGbp&&Boolean(text(row.notes));
  if(currency&&currency!=="GBP"&&!hasRate&&!hasManualGbp)warnings.push("foreign_currency_without_conversion");
  if(!text(row.vat_treatment)||row.vat_treatment==="pending_review")warnings.push("pending_vat_treatment");
  if(!row.supplier_country)warnings.push("supplier_country_missing");
  if(Number(row.recoverable_vat_amount)>0&&!row.supplier_vat_number)warnings.push("supplier_vat_number_missing");
  if(row.vat_treatment==="reverse_charge_review_required")warnings.push("reverse_charge_review_required");
  if(row.business_use_percentage!==null&&row.business_use_percentage!==undefined&&Number(row.business_use_percentage)<1)warnings.push("personal_mixed_use_review_required");
  return warnings;
};
const warningMessages:Record<string,string>={
  gross_net_vat_mismatch:"Net plus VAT must equal gross.",
  foreign_currency_without_conversion:"Foreign-currency conversion data is incomplete.",
  pending_vat_treatment:"VAT treatment must be selected.",
  supplier_country_missing:"Supplier country is not recorded.",
  supplier_vat_number_missing:"Supplier VAT number is not recorded for the VAT claim.",
  reverse_charge_review_required:"Reverse-charge treatment requires review.",
  personal_mixed_use_review_required:"Business-use and recoverable VAT treatment requires review.",
  vat_net_amount_missing:"Net amount is required for this VAT treatment.",
  vat_amount_missing:"VAT amount is required for this VAT treatment.",
  vat_gross_amount_missing:"Gross amount is required for VAT review.",
  vat_rate_missing:"VAT rate is required for this VAT treatment.",
  vat_period_unconfirmed:"VAT period must be explicitly confirmed.",
  no_supplier_invoice:"Supplier VAT evidence is missing.",
  vat_invoice_review_pending:"VAT invoice evidence has not been verified.",
  payment_evidence_missing:"Payment evidence is not linked.",
  possible_duplicate:"Possible historical duplicate; confirm before export.",
};
export const vatWarningSeverity=(code:string):VatWarningSeverity=>
  ["gross_net_vat_mismatch","foreign_currency_without_conversion","pending_vat_treatment","reverse_charge_review_required","vat_net_amount_missing","vat_amount_missing","vat_gross_amount_missing","vat_rate_missing","vat_period_unconfirmed"].includes(code)?"critical":
    ["supplier_vat_number_missing","personal_mixed_use_review_required","no_supplier_invoice","vat_invoice_review_pending","vat_period_conflict"].includes(code)?"review_required":"advisory";
const validationIssue=(code:string):VatValidationIssue=>({code,severity:vatWarningSeverity(code),message:warningMessages[code]??code.replace(/_/g," ")});
export const reviewCompletionIssues=(row:Input):VatValidationIssue[]=>{
  const codes=expenseWarnings(row).filter(code=>vatWarningSeverity(code)==="critical");
  const treatment=text(row.vat_treatment);
  const requiresVatAmounts=treatment==="standard_rated"||treatment==="reduced_rated";
  const net=row.gbp_net_amount??row.net_amount,vat=row.gbp_vat_amount??row.vat_amount,gross=row.gbp_gross_amount??row.gross_amount;
  const present=(value:unknown)=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));
  if(requiresVatAmounts&&!present(net))codes.push("vat_net_amount_missing");
  if(requiresVatAmounts&&(!present(vat)||Number(vat)<=0))codes.push("vat_amount_missing");
  if(!present(gross))codes.push("vat_gross_amount_missing");
  if(requiresVatAmounts&&!present(row.vat_rate))codes.push("vat_rate_missing");
  if(!text(row.vat_period_id))codes.push("vat_period_unconfirmed");
  return [...new Set(codes)].map(validationIssue);
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

export const listVatPeriods=async(db:Db=pool)=>(await db.query("SELECT p.*,p.start_date::text AS start_date,p.end_date::text AS end_date,p.filing_deadline::text AS filing_deadline FROM finance_os.vat_periods p ORDER BY p.start_date")).rows;
export const suggestVatPeriod=async(value:unknown,db:Db=pool)=>{
  const taxPoint=date(value);if(!taxPoint)return null;
  const periods=(await db.query("SELECT * FROM finance_os.vat_periods WHERE $1::date BETWEEN start_date AND end_date ORDER BY start_date",[taxPoint])).rows as VatPeriod[];
  if(periods.length===1)return{...periods[0],vat_period_source:"derived" as const,effective_tax_point_date:taxPoint};
  if(periods.length>1)return{id:null,vat_period_source:"conflict" as const,effective_tax_point_date:taxPoint,matching_period_ids:periods.map(period=>period.id)};
  return null;
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
  const expenseId=uuid(id);
  if(value.vat_review_status==="review_complete"){
    const existing=(await db.query("SELECT * FROM finance_os.expenses WHERE id=$1",[expenseId])).rows[0];
    if(!existing)throw vatError("Expense not found","expense_not_found",404);
    const issues=reviewCompletionIssues({...existing,...value});
    if(issues.length)throw vatError("Cannot mark VAT review complete","vat_review_blocked",409,{issues});
  }
  const params=fields.map(f=>value[f]);
  const result=await db.query(`UPDATE finance_os.expenses SET ${fields.map((f,i)=>`${f}=$${i+1}`).join(",")},updated_by=$${fields.length+1},change_reason=$${fields.length+2} WHERE id=$${fields.length+3} RETURNING *`,[...params,userId,reason,expenseId]);
  if(!result.rows[0])throw vatError("Expense not found","expense_not_found",404);
  const warnings=expenseWarnings(result.rows[0]);
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
  const requestedPeriodId=periodId?uuid(periodId):null;
  const periods=await listVatPeriods(db) as VatPeriod[];
  const result=await db.query(`SELECT e.*,e.invoice_date::text AS invoice_date,e.transaction_date::text AS transaction_date,e.payment_date::text AS payment_date,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ev.id,'filename',ev.original_filename,'type',ev.vat_evidence_type,'verification_status',ev.verification_status,'document_status',ev.document_status)) FROM finance_os.evidence_links l JOIN finance_os.evidence ev ON ev.id=l.evidence_id WHERE l.entity_type='expense' AND l.entity_id=e.id),'[]'::jsonb) evidence_files,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',a.id,'adjustment_type',a.adjustment_type,'adjustment_date',a.adjustment_date::text,
      'gross_amount',a.gross_amount,'gbp_gross_amount',a.gbp_gross_amount,'currency',a.currency,
      'supplier_reference',a.supplier_reference,'reason',a.reason,'review_status',a.review_status,
      'parent_order_reference',e.order_reference,'parent_invoice_number',e.invoice_number,
      'evidence_files',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',aev.id,'filename',aev.original_filename,'type',aev.vat_evidence_type)) FROM finance_os.evidence_links al JOIN finance_os.evidence aev ON aev.id=al.evidence_id WHERE al.entity_type='expense_adjustment' AND al.entity_id=a.id),'[]'::jsonb)
    ) ORDER BY a.adjustment_date,a.id) FROM finance_os.expense_adjustments a WHERE a.expense_id=e.id),'[]'::jsonb) adjustments
    FROM finance_os.expenses e WHERE e.archived_at IS NULL ORDER BY COALESCE(e.invoice_date,e.transaction_date,e.payment_date),e.created_at`);
  const resolved=result.rows.map(row=>({row,resolution:resolveVatPeriod(row,periods)})).filter(({resolution})=>!requestedPeriodId||resolution.effective_vat_period_id===requestedPeriodId);
  const duplicateKeys=new Map<string,number>();
  for(const {row} of resolved){const key=[row.supplier_name,row.transaction_date??row.payment_date,row.gross_amount].join("|");duplicateKeys.set(key,(duplicateKeys.get(key)??0)+1);}
  return resolved.map(({row,resolution})=>{
    const files=Array.isArray(row.evidence_files)?row.evidence_files:[];
    const types=files.map((f:{type?:unknown})=>String(f.type??""));
    const supplier=types.some((t:string)=>["full_vat_invoice","simplified_vat_invoice","retail_receipt","supplier_invoice_no_vat","credit_note"].includes(t));
    const payment=types.some((t:string)=>["paypal_payment_receipt","card_bank_statement","proof_of_payment"].includes(t));
    const vatInvoice=types.some((t:string)=>["full_vat_invoice","simplified_vat_invoice"].includes(t));
    const adjustment=types.some((t:string)=>["credit_note","refund_confirmation"].includes(t));
    const coverage=adjustment?"refund_or_credit_adjustment_present":vatInvoice?"vat_invoice_present":supplier&&payment?"supplier_document_plus_payment_evidence":supplier?"supplier_document_only":payment?"payment_evidence_only":files.length?"requires_review":"no_evidence";
    const warnings=expenseWarnings(row);
    if(resolution.vat_period_source==="conflict")warnings.push("vat_period_conflict");
    if(!supplier)warnings.push("no_supplier_invoice");if(!payment)warnings.push("payment_evidence_missing");
    const key=[row.supplier_name,row.transaction_date??row.payment_date,row.gross_amount].join("|");if((duplicateKeys.get(key)??0)>1)warnings.push("possible_duplicate");
    const effectivePeriod=periods.find(period=>period.id===resolution.effective_vat_period_id);
    return normalizeVatLedgerRow({...row,...resolution,vat_period_start:effectivePeriod?.start_date??null,vat_period_end:effectivePeriod?.end_date??null,evidence_coverage:coverage,warnings,warning_details:warnings.map(validationIssue)});
  });
};
export const createComplianceDocument=async(input:Input,userId:string,db:Db=pool)=>{
  const types=["hmrc_vat_registration_notice","hmrc_vat_assessment","hmrc_debt_management_letter","annual_accounting_scheme_correspondence","vat_liability_statement","penalty_notice","hmrc_general_correspondence","other_compliance_document"];
  const type=optionalEnum(input.compliance_type,types);if(!type)throw vatError("compliance_type is required");
  const result=await db.query(`INSERT INTO finance_os.compliance_documents(evidence_id,compliance_type,company_id,vat_period_id,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uuid(input.evidence_id),type,uuid(input.company_id),input.vat_period_id?uuid(input.vat_period_id):null,text(input.notes),userId]);return result.rows[0];
};
export const listComplianceDocuments=async(db:Db=pool)=>(await db.query(`SELECT c.*,e.title,e.original_filename,e.document_date,e.created_at AS uploaded_at FROM finance_os.compliance_documents c JOIN finance_os.evidence e ON e.id=c.evidence_id ORDER BY e.document_date DESC NULLS LAST,c.created_at DESC`)).rows;
