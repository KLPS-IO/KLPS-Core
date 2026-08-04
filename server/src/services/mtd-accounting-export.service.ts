import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { getVatLedger, listVatPeriods } from "./finance-vat.service";

type Db=Pick<PoolClient,"query">;
type Json=Record<string,unknown>;
export const MTD_EXPORT_TYPE="mtd_accounting" as const;
export const QUICKFILE_PROFILE="quickfile_purchase_csv_v1" as const;
export const QUICKFILE_HEADERS=["Receipt date","Supplier name","Description","Total gross amount","Currency","Exchange rate","Supplier Ref.","VAT total","VAT rate","Purchase nominal code","Paid date","Paid account nominal code"] as const;
export type ExportConfig={categoryNominalCodes:Record<string,string>;paymentAccountNominalCodes:Record<string,string>};
export type ExportValidation={export_type:typeof MTD_EXPORT_TYPE;profile:typeof QUICKFILE_PROFILE;validation_mode:"dry_run";generated_at:string;vat_period:Json;eligible_row_count:number;blocked_row_count:number;blocked_expense_ids:string[];blocking_reasons:Record<string,string[]>;mapped_nominal_codes:Record<string,string>;missing_nominal_mappings:string[];payment_account_mappings:Record<string,string>;adjustment_handling:{strategy:string;manual_adjustment_count:number;items:Array<{adjustment_id:string;expense_id:string;reason:string}>};expected_csv_headings:readonly string[];source_ledger_fingerprint:string;rows:ExportRow[]};
export type ExportRow={expense_id:string;values:Record<(typeof QUICKFILE_HEADERS)[number],string>};

const exportError=(message:string,code:string,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const normalise=(value:unknown)=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
const money=(value:unknown)=>Number(value).toFixed(2);
const dateOnly=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):clean(value).slice(0,10);
const present=(value:unknown)=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.entries(value as Json).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
const fingerprint=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const csvCell=(value:string)=>/[",\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value;
export const rowsToCsv=(rows:ExportRow[])=>[QUICKFILE_HEADERS.join(","),...rows.map(row=>QUICKFILE_HEADERS.map(header=>csvCell(row.values[header])).join(","))].join("\r\n")+"\r\n";

const parseMap=(name:string,value=process.env[name])=>{
  if(!value)return {};
  try{const parsed=JSON.parse(value);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error();return Object.fromEntries(Object.entries(parsed).filter(([,v])=>typeof v==="string"&&v.trim()).map(([k,v])=>[normalise(k),clean(v)]));}
  catch{throw exportError(`${name} must be a JSON object of reviewed nominal-code mappings`,`invalid_${name.toLowerCase()}`,500);}
};
export const loadExportConfig=():ExportConfig=>({
  categoryNominalCodes:parseMap("MTD_ACCOUNTING_CATEGORY_NOMINAL_CODES"),
  paymentAccountNominalCodes:parseMap("MTD_ACCOUNTING_PAYMENT_ACCOUNT_NOMINAL_CODES")
});
const mapping=(map:Record<string,string>,value:unknown)=>map[normalise(value)]||map.default||"";
const paymentSource=(row:Json)=>row.founder_paid===true?"founder_director_funded":normalise(row.payment_source||row.payment_method||row.paid_by||row.payment_channel||"other");
const supplierReference=(row:Json)=>clean(row.invoice_number)||clean(row.order_reference)||clean((row.metadata as Json|undefined)?.payment_reference)||clean(row.evidence_reference)||`FOS-${clean(row.import_key)||clean(row.id)}`;

export const validateExpenseForQuickFile=(row:Json,config:ExportConfig):{reasons:string[];row:ExportRow|null;nominal:string;paymentCode:string}=>{
  const reasons:string[]=[];
  const supplier=clean(row.supplier_name),description=clean(row.description)||clean(row.name),currency=(clean(row.currency)||"GBP").toUpperCase();
  const taxDate=dateOnly(row.effective_tax_point_date||row.invoice_date||row.transaction_date||row.payment_date);
  const gross=row.gbp_gross_amount,vat=row.gbp_vat_amount,net=row.gbp_net_amount;
  const nominal=mapping(config.categoryNominalCodes,row.category);
  const paidDate=dateOnly(row.payment_date),source=paymentSource(row),paymentCode=paidDate?mapping(config.paymentAccountNominalCodes,source):"";
  if(clean(row.vat_review_status)!=="review_complete")reasons.push("review_not_export_ready");
  if(!clean(row.vat_treatment)||clean(row.vat_treatment)==="pending_review")reasons.push("vat_treatment_pending");
  if(!taxDate)reasons.push("effective_tax_point_missing");
  if(!supplier)reasons.push("supplier_missing");
  if(!description)reasons.push("description_missing");
  if(!present(gross))reasons.push("approved_gbp_gross_missing");
  if(!present(vat))reasons.push("reviewed_gbp_vat_missing");
  if(!present(row.vat_rate))reasons.push("vat_rate_unresolved");
  if(present(net)&&present(vat)&&present(gross)&&Math.abs(Number(net)+Number(vat)-Number(gross))>0.01)reasons.push("gbp_values_do_not_reconcile");
  if(!nominal)reasons.push("purchase_nominal_code_missing");
  if(paidDate&&!paymentCode)reasons.push(`paid_account_nominal_code_missing:${source}`);
  if(currency!=="GBP"&&!(Number(row.exchange_rate)>0&&present(row.gbp_gross_amount)))reasons.push("foreign_currency_conversion_unresolved");
  const warnings=Array.isArray(row.warnings)?row.warnings.map(String):[];
  if(!Array.isArray(row.evidence_files)||row.evidence_files.length===0)reasons.push("evidence_requirement_unsatisfied");
  for(const warning of warnings)if(!["payment_evidence_missing"].includes(warning)||paidDate)reasons.push(`critical_warning:${warning}`);
  if(reasons.length)return{reasons:[...new Set(reasons)],row:null,nominal,paymentCode};
  const rate=Number(row.vat_rate)<=1?Number(row.vat_rate)*100:Number(row.vat_rate);
  return{reasons:[],nominal,paymentCode,row:{expense_id:clean(row.id),values:{
    "Receipt date":taxDate,"Supplier name":supplier,"Description":description,"Total gross amount":money(gross),"Currency":currency,
    "Exchange rate":currency==="GBP"?"":String(row.exchange_rate),"Supplier Ref.":supplierReference(row),"VAT total":money(vat),
    "VAT rate":Number.isInteger(rate)?String(rate):String(Number(rate.toFixed(4))),"Purchase nominal code":nominal,"Paid date":paidDate,"Paid account nominal code":paymentCode
  }}};
};

export async function validateAccountingExport(input:Json,config=loadExportConfig(),db:Db=pool):Promise<ExportValidation>{
  if(input.profile!==QUICKFILE_PROFILE)throw exportError("Unsupported accounting export profile","unsupported_accounting_export_profile",400);
  const periodId=clean(input.vat_period_id);if(!/^[0-9a-f-]{36}$/i.test(periodId))throw exportError("vat_period_id must be a UUID","invalid_vat_period_id");
  const periods=await listVatPeriods(db);const period=periods.find(p=>p.id===periodId);if(!period)throw exportError("VAT period not found","vat_period_not_found",404);
  const ledger=await getVatLedger(periodId,db);
  const adjustments=(await db.query(`SELECT a.id,a.expense_id,a.adjustment_type,a.adjustment_date::text adjustment_date,a.gbp_net_amount,a.gbp_vat_amount,a.gbp_gross_amount,a.reason,a.supplier_reference,a.review_status FROM finance_os.expense_adjustments a JOIN finance_os.expenses e ON e.id=a.expense_id WHERE e.archived_at IS NULL AND a.adjustment_date BETWEEN $1 AND $2 ORDER BY a.adjustment_date,a.id`,[period.start_date,period.end_date])).rows;
  const ordered=[...ledger].sort((a,b)=>`${dateOnly(a.effective_tax_point_date)}|${a.id}`.localeCompare(`${dateOnly(b.effective_tax_point_date)}|${b.id}`));
  const rows:ExportRow[]=[],blockingReasons:Record<string,string[]>={},mapped:Record<string,string>={},paymentMapped:Record<string,string>={},missing=new Set<string>();
  for(const expense of ordered){const result=validateExpenseForQuickFile(expense,config);if(result.nominal)mapped[clean(expense.category)||"Uncategorised"]=result.nominal;else missing.add(clean(expense.category)||"Uncategorised");if(result.paymentCode)paymentMapped[paymentSource(expense)]=result.paymentCode;if(result.row)rows.push(result.row);else blockingReasons[clean(expense.id)]=result.reasons;}
  const manual=adjustments.map(a=>({adjustment_id:clean(a.id),expense_id:clean(a.expense_id),reason:`${clean(a.adjustment_type)} requires controlled QuickFile credit-note entry; purchase CSV does not prove safe parent linkage`}));
  const source={period_id:periodId,profile:QUICKFILE_PROFILE,ledger:ordered.map(row=>({...row,evidence_files:(row.evidence_files as Json[]|undefined)?.map(e=>({id:e.id,type:e.type}))})),adjustments,config};
  return{export_type:MTD_EXPORT_TYPE,profile:QUICKFILE_PROFILE,validation_mode:"dry_run",generated_at:new Date().toISOString(),vat_period:period,eligible_row_count:rows.length,blocked_row_count:Object.keys(blockingReasons).length,blocked_expense_ids:Object.keys(blockingReasons),blocking_reasons:blockingReasons,mapped_nominal_codes:mapped,missing_nominal_mappings:[...missing].sort(),payment_account_mappings:paymentMapped,adjustment_handling:{strategy:"exclude_from_purchase_csv_and_require_manual_credit_note",manual_adjustment_count:manual.length,items:manual},expected_csv_headings:QUICKFILE_HEADERS,source_ledger_fingerprint:fingerprint(source),rows};
}

export async function generateAccountingExport(input:Json,userId:string,config=loadExportConfig(),db:Db=pool){
  const expected=clean(input.expected_source_fingerprint);if(!/^[a-f0-9]{64}$/.test(expected))throw exportError("expected_source_fingerprint is required","invalid_source_fingerprint");
  const validation=await validateAccountingExport(input,config,db);
  if(validation.source_ledger_fingerprint!==expected)throw exportError("Source ledger changed after validation","accounting_export_source_changed",409);
  if(validation.blocked_row_count>0)throw exportError("Accounting export is blocked by unresolved rows","accounting_export_validation_failed",409);
  await auditAccountingExport("accounting_export_generated",validation,userId,db);
  return{validation,csv:rowsToCsv(validation.rows)};
}

export const auditAccountingExport=async(eventType:string,validation:ExportValidation,userId:string,db:Db=pool)=>db.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES($1,'vat_period',$2,$3,$4::jsonb,$5)`,[eventType,validation.vat_period.id,`MTD Accounting Export ${eventType.replace(/^accounting_export_/,"")}`,JSON.stringify({export_type:validation.export_type,profile:validation.profile,vat_period_id:validation.vat_period.id,eligible_row_count:validation.eligible_row_count,blocked_row_count:validation.blocked_row_count,source_ledger_fingerprint:validation.source_ledger_fingerprint,generated_at:validation.generated_at,manual_adjustment_count:validation.adjustment_handling.manual_adjustment_count}),userId]);
