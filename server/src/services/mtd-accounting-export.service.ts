import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { getVatLedger, listVatPeriods, vatWarningSeverity } from "./finance-vat.service";
import {
  ExportConfig,
  loadEnvironmentExportConfig,
  resolveAccountingExportConfig
} from "./accounting-export-config.service";
export type { ExportConfig } from "./accounting-export-config.service";

type Db=Pick<PoolClient,"query">;
type Json=Record<string,unknown>;
export const MTD_EXPORT_TYPE="mtd_accounting" as const;
export const QUICKFILE_PROFILE="quickfile_purchase_csv_v1" as const;
export const QUICKFILE_HEADERS=["Receipt date","Supplier name","Description","Total gross amount","Currency","Exchange rate","Supplier Ref.","VAT total","VAT rate","Purchase nominal code","Paid date","Paid account nominal code"] as const;
export type ManualAdjustment={adjustment_id:string;parent_expense_id:string;adjustment_type:string;adjustment_date:string;gross_amount:string|null;currency:string;gbp_gross_amount:string|null;net_amount:string|null;vat_amount:string|null;gbp_net_amount:string|null;gbp_vat_amount:string|null;supplier_reference:string|null;reason:string;review_status:string;parent_supplier_name:string;parent_transaction_date:string|null;parent_invoice_date:string|null;parent_payment_date:string|null;parent_order_reference:string|null;parent_invoice_number:string|null;parent_payment_reference:string|null;parent_gross_amount:string|null;effective_parent_reference:string;recommended_action:string;included_in_primary_csv:false};
export type ExportValidation={export_type:typeof MTD_EXPORT_TYPE;profile:typeof QUICKFILE_PROFILE;validation_mode:"dry_run";generated_at:string;vat_period:Json;eligible_row_count:number;blocked_row_count:number;blocked_expense_ids:string[];blocking_reasons:Record<string,string[]>;mapping_config_source:"database"|"environment"|"none";mapping_config_confirmed:boolean;mapping_config_version:number;mapped_nominal_codes:Record<string,string>;missing_nominal_mappings:string[];payment_account_mappings:Record<string,string>;unmapped_payment_sources:string[];adjustment_handling:{strategy:string;manual_adjustment_count:number;items:ManualAdjustment[]};expected_csv_headings:readonly string[];source_ledger_fingerprint:string;rows:ExportRow[]};
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

export const loadExportConfig=loadEnvironmentExportConfig;
const mapping=(map:Record<string,string>,value:unknown)=>Object.entries(map).find(([key])=>normalise(key)===normalise(value))?.[1]||map.default||"";
const paymentSource=(row:Json)=>row.founder_paid===true?"founder_director_funded":normalise(row.payment_source||row.payment_method||row.paid_by||row.payment_channel||"other");
const supplierReference=(row:Json)=>clean(row.invoice_number)||clean(row.order_reference)||clean((row.metadata as Json|undefined)?.payment_reference)||clean(row.evidence_reference)||`FOS-${clean(row.import_key)||clean(row.id)}`;
const optionalMoney=(value:unknown)=>present(value)?money(value):null;
const nullableText=(value:unknown)=>clean(value)||null;
export const manualAdjustmentProjection=(row:Json):ManualAdjustment=>({
  adjustment_id:clean(row.id),parent_expense_id:clean(row.expense_id),adjustment_type:clean(row.adjustment_type),adjustment_date:dateOnly(row.adjustment_date),
  gross_amount:optionalMoney(row.gross_amount),currency:(clean(row.currency)||"GBP").toUpperCase(),gbp_gross_amount:optionalMoney(row.gbp_gross_amount),net_amount:optionalMoney(row.net_amount),vat_amount:optionalMoney(row.vat_amount),gbp_net_amount:optionalMoney(row.gbp_net_amount),gbp_vat_amount:optionalMoney(row.gbp_vat_amount),
  supplier_reference:nullableText(row.supplier_reference),reason:clean(row.reason),review_status:clean(row.review_status),parent_supplier_name:clean(row.parent_supplier_name),parent_transaction_date:nullableText(dateOnly(row.parent_transaction_date)),parent_invoice_date:nullableText(dateOnly(row.parent_invoice_date)),parent_payment_date:nullableText(dateOnly(row.parent_payment_date)),parent_order_reference:nullableText(row.parent_order_reference),parent_invoice_number:nullableText(row.parent_invoice_number),parent_payment_reference:nullableText(row.parent_payment_reference),parent_gross_amount:optionalMoney(row.parent_gross_amount),
  effective_parent_reference:clean(row.parent_invoice_number)||clean(row.parent_order_reference)||clean(row.parent_payment_reference)||clean(row.parent_stable_reference),recommended_action:"Enter this separately in QuickFile as a purchase credit or supplier refund and link it to the original purchase where QuickFile permits.",included_in_primary_csv:false
});

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
  for(const warning of warnings)if(vatWarningSeverity(warning)!=="advisory"||warning==="possible_duplicate")reasons.push(`critical_warning:${warning}`);
  if(reasons.length)return{reasons:[...new Set(reasons)],row:null,nominal,paymentCode};
  const rate=Number(row.vat_rate)<=1?Number(row.vat_rate)*100:Number(row.vat_rate);
  return{reasons:[],nominal,paymentCode,row:{expense_id:clean(row.id),values:{
    "Receipt date":taxDate,"Supplier name":supplier,"Description":description,"Total gross amount":money(gross),"Currency":currency,
    "Exchange rate":currency==="GBP"?"":String(row.exchange_rate),"Supplier Ref.":supplierReference(row),"VAT total":money(vat),
    "VAT rate":Number.isInteger(rate)?String(rate):String(Number(rate.toFixed(4))),"Purchase nominal code":nominal,"Paid date":paidDate,"Paid account nominal code":paymentCode
  }}};
};

export async function validateAccountingExport(input:Json,config?:ExportConfig,db:Db=pool):Promise<ExportValidation>{
  if(input.profile!==QUICKFILE_PROFILE)throw exportError("Unsupported accounting export profile","unsupported_accounting_export_profile",400);
  const resolved=config?{config,source:"database" as const,confirmed:true,version:1,usableForGeneration:true}:await resolveAccountingExportConfig(input.profile,db);
  const periodId=clean(input.vat_period_id);if(!/^[0-9a-f-]{36}$/i.test(periodId))throw exportError("vat_period_id must be a UUID","invalid_vat_period_id");
  const periods=await listVatPeriods(db);const period=periods.find(p=>p.id===periodId);if(!period)throw exportError("VAT period not found","vat_period_not_found",404);
  const ledger=await getVatLedger(periodId,db);
  const adjustments=(await db.query(`SELECT a.id,a.expense_id,a.adjustment_type,a.adjustment_date::text adjustment_date,a.gross_amount,a.currency,a.gbp_gross_amount,a.net_amount,a.vat_amount,a.gbp_net_amount,a.gbp_vat_amount,a.supplier_reference,a.reason,a.review_status,e.supplier_name parent_supplier_name,e.transaction_date::text parent_transaction_date,e.invoice_date::text parent_invoice_date,e.payment_date::text parent_payment_date,e.order_reference parent_order_reference,e.invoice_number parent_invoice_number,e.metadata->>'payment_reference' parent_payment_reference,e.gross_amount parent_gross_amount,e.import_key parent_stable_reference,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ev.id,'type',ev.vat_evidence_type) ORDER BY ev.id) FROM finance_os.evidence_links l JOIN finance_os.evidence ev ON ev.id=l.evidence_id WHERE l.entity_type='expense_adjustment' AND l.entity_id=a.id),'[]'::jsonb) evidence_files FROM finance_os.expense_adjustments a JOIN finance_os.expenses e ON e.id=a.expense_id WHERE e.archived_at IS NULL AND a.adjustment_date BETWEEN $1 AND $2 ORDER BY a.adjustment_date,a.id`,[period.start_date,period.end_date])).rows;
  const ordered=[...ledger].sort((a,b)=>`${dateOnly(a.effective_tax_point_date)}|${a.id}`.localeCompare(`${dateOnly(b.effective_tax_point_date)}|${b.id}`));
  const rows:ExportRow[]=[],blockingReasons:Record<string,string[]>={},mapped:Record<string,string>={},paymentMapped:Record<string,string>={},missing=new Set<string>();
  const missingPayment=new Set<string>();
  for(const expense of ordered){const result=validateExpenseForQuickFile(expense,resolved.config);if(result.nominal)mapped[clean(expense.category)||"Uncategorised"]=result.nominal;else missing.add(clean(expense.category)||"Uncategorised");const source=paymentSource(expense);if(result.paymentCode)paymentMapped[source]=result.paymentCode;else if(dateOnly(expense.payment_date))missingPayment.add(source);if(result.row)rows.push(result.row);else blockingReasons[clean(expense.id)]=result.reasons;}
  const manual=adjustments.map(manualAdjustmentProjection);
  const source={period_id:periodId,profile:QUICKFILE_PROFILE,ledger:ordered.map(row=>({...row,evidence_files:(row.evidence_files as Json[]|undefined)?.map(e=>({id:e.id,type:e.type}))})),adjustments,config:resolved.config,config_source:resolved.source,config_confirmed:resolved.confirmed,config_version:resolved.version};
  return{export_type:MTD_EXPORT_TYPE,profile:QUICKFILE_PROFILE,validation_mode:"dry_run",generated_at:new Date().toISOString(),vat_period:period,eligible_row_count:rows.length,blocked_row_count:Object.keys(blockingReasons).length,blocked_expense_ids:Object.keys(blockingReasons),blocking_reasons:blockingReasons,mapping_config_source:resolved.source,mapping_config_confirmed:resolved.confirmed,mapping_config_version:resolved.version,mapped_nominal_codes:mapped,missing_nominal_mappings:[...missing].sort(),payment_account_mappings:paymentMapped,unmapped_payment_sources:[...missingPayment].sort(),adjustment_handling:{strategy:"exclude_from_purchase_csv_and_require_manual_credit_note",manual_adjustment_count:manual.length,items:manual},expected_csv_headings:QUICKFILE_HEADERS,source_ledger_fingerprint:fingerprint(source),rows};
}

export async function generateAccountingExport(input:Json,userId:string,config?:ExportConfig,db:Db=pool){
  const expected=clean(input.expected_source_fingerprint);if(!/^[a-f0-9]{64}$/.test(expected))throw exportError("expected_source_fingerprint is required","invalid_source_fingerprint");
  const validation=await validateAccountingExport(input,config,db);
  if(validation.mapping_config_source==="database"&&!validation.mapping_config_confirmed)throw exportError("Founder-saved mappings must be explicitly confirmed before generation","accounting_export_config_unconfirmed",409);
  if(validation.mapping_config_source==="none")throw exportError("Confirmed accounting export mappings are required","accounting_export_config_missing",409);
  if(validation.source_ledger_fingerprint!==expected)throw exportError("Source ledger changed after validation","accounting_export_source_changed",409);
  if(validation.blocked_row_count>0)throw exportError("Accounting export is blocked by unresolved rows","accounting_export_validation_failed",409);
  await auditAccountingExport("accounting_export_generated",validation,userId,db);
  return{validation,csv:rowsToCsv(validation.rows)};
}

export const auditAccountingExport=async(eventType:string,validation:ExportValidation,userId:string,db:Db=pool)=>db.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES($1,'vat_period',$2,$3,$4::jsonb,$5)`,[eventType,validation.vat_period.id,`MTD Accounting Export ${eventType.replace(/^accounting_export_/,"")}`,JSON.stringify({export_type:validation.export_type,profile:validation.profile,vat_period_id:validation.vat_period.id,eligible_row_count:validation.eligible_row_count,blocked_row_count:validation.blocked_row_count,source_ledger_fingerprint:validation.source_ledger_fingerprint,generated_at:validation.generated_at,manual_adjustment_count:validation.adjustment_handling.manual_adjustment_count,manual_adjustment_ids:validation.adjustment_handling.items.map(item=>item.adjustment_id),manual_adjustment_types:[...new Set(validation.adjustment_handling.items.map(item=>item.adjustment_type))]}),userId]);
