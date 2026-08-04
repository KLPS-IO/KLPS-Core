/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateAccountingExport,
  MTD_EXPORT_TYPE,
  QUICKFILE_HEADERS,
  QUICKFILE_PROFILE,
  rowsToCsv,
  validateAccountingExport,
  validateExpenseForQuickFile,
  type ExportConfig
} from "./mtd-accounting-export.service";

const periodId="11111111-1111-4111-8111-111111111111",expenseId="22222222-2222-4222-8222-222222222222",userId="33333333-3333-4333-8333-333333333333";
const config:ExportConfig={categoryNominalCodes:{software:"7001"},paymentAccountNominalCodes:{founder_director_funded:"3100",paypal:"1201"}};
const valid={id:expenseId,import_key:"expense-1",name:"Software purchase",description:"Reviewed software purchase",supplier_name:"Supplier Ltd",category:"Software",currency:"GBP",invoice_date:"2026-06-01",transaction_date:"2026-06-02",payment_date:"2026-06-02",gbp_net_amount:"10.00",gbp_vat_amount:"2.00",gbp_gross_amount:"12.00",vat_amount:"2.00",vat_rate:"0.20",vat_treatment:"standard_rated",vat_review_status:"review_complete",supplier_country:"GB",invoice_number:"INV-1",founder_paid:true,evidence_files:[{id:"e",type:"full_vat_invoice"},{id:"p",type:"proof_of_payment"}],warnings:[]};

test("QuickFile purchase CSV uses the exact provider headings and deterministic CRLF output",()=>{
  assert.deepEqual(QUICKFILE_HEADERS,["Receipt date","Supplier name","Description","Total gross amount","Currency","Exchange rate","Supplier Ref.","VAT total","VAT rate","Purchase nominal code","Paid date","Paid account nominal code"]);
  const accepted=validateExpenseForQuickFile(valid,config).row!;
  assert.equal(rowsToCsv([accepted]).split("\r\n")[0],QUICKFILE_HEADERS.join(","));
  assert.equal(accepted.values["Receipt date"],"2026-06-01");
  assert.equal(accepted.values["VAT rate"],"20");
  assert.equal(accepted.values["Exchange rate"],"");
});

test("CSV safely quotes commas, quotes and newlines",()=>{
  const row=validateExpenseForQuickFile({...valid,description:'One, "reviewed"\nitem'},config).row!;
  assert.match(rowsToCsv([row]),/"One, ""reviewed""\nitem"/);
});

test("reviewed explicit no-VAT row exports zero VAT and zero rate",()=>{
  const result=validateExpenseForQuickFile({...valid,vat_treatment:"no_vat_shown",vat_rate:"0",gbp_net_amount:"12",gbp_vat_amount:"0",gbp_gross_amount:"12"},config);
  assert.deepEqual(result.reasons,[]);assert.equal(result.row!.values["VAT total"],"0.00");assert.equal(result.row!.values["VAT rate"],"0");
});

test("pending VAT, missing VAT, nominal mapping and foreign conversion are blocked",()=>{
  assert.ok(validateExpenseForQuickFile({...valid,vat_treatment:"pending_review"},config).reasons.includes("vat_treatment_pending"));
  assert.ok(validateExpenseForQuickFile({...valid,gbp_vat_amount:null},config).reasons.includes("reviewed_gbp_vat_missing"));
  assert.ok(validateExpenseForQuickFile({...valid,category:"Unknown"},config).reasons.includes("purchase_nominal_code_missing"));
  assert.ok(validateExpenseForQuickFile({...valid,currency:"EUR",exchange_rate:null},config).reasons.includes("foreign_currency_conversion_unresolved"));
});

test("founder-funded paid purchases require their reviewed account mapping",()=>{
  assert.equal(validateExpenseForQuickFile(valid,config).row!.values["Paid account nominal code"],"3100");
  assert.ok(validateExpenseForQuickFile(valid,{...config,paymentAccountNominalCodes:{} }).reasons.includes("paid_account_nominal_code_missing:founder_director_funded"));
});

const db=(expense={...valid},adjustments:Record<string,unknown>[]=[]):{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}=>({query:async(sql:string)=>{
  if(sql.includes("FROM finance_os.vat_periods"))return{rows:[{id:periodId,start_date:"2026-05-01",end_date:"2026-07-31",status:"open"}]};
  if(sql.includes("FROM finance_os.expenses e"))return{rows:[expense]};
  if(sql.includes("FROM finance_os.expense_adjustments"))return{rows:adjustments};
  if(sql.includes("INSERT INTO finance_os.finance_events"))return{rows:[]};
  throw new Error(`Unexpected SQL: ${sql}`);
}});

test("validation is provider-neutral, deterministic and reports manual refund handling",async()=>{
  const adjustments=[{id:"44444444-4444-4444-8444-444444444444",expense_id:expenseId,adjustment_type:"partial_refund",adjustment_date:"2026-06-03",gbp_gross_amount:"0.99",review_status:"review_complete"}];
  const first=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,adjustments) as never);
  const second=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,adjustments) as never);
  assert.equal(first.export_type,MTD_EXPORT_TYPE);assert.equal(first.eligible_row_count,1);assert.equal(first.blocked_row_count,0);
  assert.equal(first.adjustment_handling.strategy,"exclude_from_purchase_csv_and_require_manual_credit_note");assert.equal(first.adjustment_handling.manual_adjustment_count,1);
  assert.equal(first.source_ledger_fingerprint,second.source_ledger_fingerprint);
});

test("fingerprint mismatch blocks generation before returning CSV",async()=>{
  await assert.rejects(generateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE,expected_source_fingerprint:"0".repeat(64)},userId,config,db() as never),(error:unknown)=>(error as {code?:string}).code==="accounting_export_source_changed");
});

test("archived expenses remain excluded and existing VAT working ledger is unchanged",()=>{
  const vat=readFileSync("server/src/services/finance-vat.service.ts","utf8");
  const routes=readFileSync("server/src/routes/finance.routes.ts","utf8");
  assert.match(vat,/FROM finance_os\.expenses e WHERE e\.archived_at IS NULL/);
  assert.match(vat,/effective_vat_period_id===requestedPeriodId/);
  assert.match(routes,/VAT working paper – not an HMRC submission/);
  assert.match(routes,/router\.post\("\/accounting-exports\/validate",requireFinanceWrite/);
  assert.match(routes,/router\.post\("\/accounting-exports\/generate",requireFinanceWrite/);
});
