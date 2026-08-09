/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateAccountingExport,
  manualAdjustmentProjection,
  MTD_EXPORT_TYPE,
  MTD_VALIDATION_CONTRACT_VERSION,
  QUICKFILE_HEADERS,
  QUICKFILE_PROFILE,
  rowsToCsv,
  validateAccountingExport,
  validateExpenseForQuickFile,
  type ExportConfig
} from "./mtd-accounting-export.service";
import { resolvePaymentSource } from "./finance-vat.service";

const periodId="11111111-1111-4111-8111-111111111111",expenseId="22222222-2222-4222-8222-222222222222",userId="33333333-3333-4333-8333-333333333333";
const config:ExportConfig={categoryNominalCodes:{software:"7001"},paymentAccountNominalCodes:{founder_director_funded:"3100",paypal:"1201"}};
const valid={id:expenseId,import_key:"expense-1",name:"Software purchase",description:"Reviewed software purchase",supplier_name:"Supplier Ltd",category:"Software",currency:"GBP",invoice_date:"2026-06-01",transaction_date:"2026-06-02",payment_date:"2026-06-02",gbp_net_amount:"10.00",gbp_vat_amount:"2.00",gbp_gross_amount:"12.00",vat_amount:"2.00",vat_rate:"0.20",vat_treatment:"standard_rated",vat_review_status:"review_complete",supplier_document_review_status:"vat_invoice_confirmed",vat_period_id:periodId,supplier_country:"GB",invoice_number:"INV-1",founder_paid:true,evidence_files:[{id:"e",type:"full_vat_invoice"},{id:"p",type:"proof_of_payment"}],warnings:[]};
const adjustment={id:"44444444-4444-4444-8444-444444444444",expense_id:expenseId,adjustment_type:"partial_refund",adjustment_date:"2026-06-03",gross_amount:"0.99",currency:"GBP",gbp_gross_amount:"0.99",net_amount:"0.83",vat_amount:"0.16",gbp_net_amount:"0.83",gbp_vat_amount:"0.16",supplier_reference:"REFUND-1",reason:"Reviewed partial refund",review_status:"review_complete",parent_supplier_name:"Supplier Ltd",parent_transaction_date:"2026-06-02",parent_invoice_date:"2026-06-01",parent_payment_date:"2026-06-02",parent_order_reference:"ORDER-1",parent_invoice_number:"INV-1",parent_payment_reference:"PAY-1",parent_gross_amount:"12.00",parent_stable_reference:"expense-1"};

test("QuickFile purchase CSV uses the exact provider headings and deterministic CRLF output",()=>{
  assert.equal(MTD_VALIDATION_CONTRACT_VERSION,3);
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

test("reviewed canonical null no-VAT values transform to explicit CSV zeroes",()=>{
  const result=validateExpenseForQuickFile({...valid,vat_treatment:"no_vat_shown",vat_rate:null,gbp_net_amount:null,gbp_vat_amount:null,gbp_gross_amount:"12"},config);
  assert.deepEqual(result.reasons,[]);
  assert.equal(result.row!.values["VAT total"],"0.00");
  assert.equal(result.row!.values["VAT rate"],"0");
});

test("pending VAT, missing VAT, nominal mapping and foreign conversion are blocked",()=>{
  assert.ok(validateExpenseForQuickFile({...valid,vat_treatment:"pending_review"},config).reasons.includes("vat_treatment_pending"));
  assert.ok(validateExpenseForQuickFile({...valid,gbp_vat_amount:null},config).reasons.includes("reviewed_gbp_vat_missing"));
  assert.ok(validateExpenseForQuickFile({...valid,category:"Unknown"},config).reasons.includes("purchase_nominal_code_missing"));
  assert.ok(validateExpenseForQuickFile({...valid,currency:"EUR",exchange_rate:null},config).reasons.includes("foreign_currency_conversion_unresolved"));
});
test("VAT-bearing treatments require reviewed net, VAT and rate",()=>{
  for(const vat_treatment of ["standard_rated","reduced_rated"]){
    assert.ok(validateExpenseForQuickFile({...valid,vat_treatment,gbp_net_amount:null},config).reasons.includes("reviewed_gbp_net_missing"));
    assert.ok(validateExpenseForQuickFile({...valid,vat_treatment,gbp_vat_amount:null},config).reasons.includes("reviewed_gbp_vat_missing"));
    assert.ok(validateExpenseForQuickFile({...valid,vat_treatment,vat_rate:null},config).reasons.includes("vat_rate_unresolved"));
  }
});
test("advisory provenance warnings do not block accounting export validation",()=>{
  const config={categoryNominalCodes:{Software:"7506"},paymentAccountNominalCodes:{founder_director_funded:"1201"},source:"database",confirmed:true,version:1} as never;
  const result=validateExpenseForQuickFile({...valid,warnings:["supplier_country_missing","payment_evidence_missing"]},config);
  assert.deepEqual(result.reasons,[]);
});

test("warning severity is preserved and export-specific evidence review is truthful",()=>{
  const advisory=validateExpenseForQuickFile({...valid,warnings:["supplier_country_missing","payment_evidence_missing"]},config);
  assert.deepEqual(advisory.canonicalWarnings,[{code:"supplier_country_missing",severity:"advisory"},{code:"payment_evidence_missing",severity:"advisory"}]);
  const reviewRequired=validateExpenseForQuickFile({...valid,vat_treatment:"no_vat_shown",vat_rate:null,gbp_net_amount:null,gbp_vat_amount:null,supplier_document_review_status:"pending_review",warnings:["no_supplier_invoice"]},config);
  assert.ok(reviewRequired.reasons.includes("supplier_document_review_required"));
  assert.ok(!reviewRequired.reasons.some(reason=>reason.startsWith("critical_warning:")));
  assert.deepEqual(reviewRequired.canonicalWarnings,[{code:"no_supplier_invoice",severity:"review_required"}]);
  assert.deepEqual(reviewRequired.blockerDetails,[{code:"supplier_document_review_required",expense_id:expenseId,message:"The linked supplier document requires founder review before accounting export."}]);
  const critical=validateExpenseForQuickFile({...valid,warnings:["gross_net_vat_mismatch"]},config);
  assert.ok(critical.reasons.includes("critical_vat_warning:gross_net_vat_mismatch"));
});

test("supplier-document decisions remain separate from VAT treatment",()=>{
  const noVat={...valid,vat_treatment:"no_vat_shown",vat_rate:"0.20",gbp_net_amount:null,gbp_vat_amount:"2.00",supplier_document_review_status:"supporting_document_accepted_no_vat_claim",evidence_files:[{id:"support",type:"supplier_invoice_no_vat"}],warnings:["no_supplier_invoice"]};
  const accepted=validateExpenseForQuickFile(noVat,config);
  assert.equal(accepted.disposition,"eligible");
  assert.equal(accepted.row?.values["VAT total"],"0.00");
  assert.equal(accepted.row?.values["VAT rate"],"0");
  assert.equal(noVat.vat_treatment,"no_vat_shown");assert.equal(noVat.gbp_vat_amount,"2.00");assert.equal(noVat.vat_rate,"0.20");
  for(const vat_treatment of ["standard_rated","reduced_rated"]){
    const result=validateExpenseForQuickFile({...valid,vat_treatment,supplier_document_review_status:"supporting_document_accepted_no_vat_claim"},config);
    assert.ok(result.reasons.includes("supplier_document_status_incompatible_with_vat_claim"));
  }
  assert.ok(validateExpenseForQuickFile({...noVat,supplier_document_review_status:"alternative_vat_evidence_requires_specialist_review"},config).reasons.includes("alternative_vat_evidence_specialist_review_required"));
  assert.ok(validateExpenseForQuickFile({...noVat,supplier_document_review_status:"vat_invoice_confirmed"},config).reasons.includes("vat_invoice_evidence_required"));
});

test("VAT rate must agree with reviewed net and VAT within currency rounding tolerance",()=>{
  assert.deepEqual(validateExpenseForQuickFile(valid,config).reasons,[]);
  assert.deepEqual(validateExpenseForQuickFile({...valid,gbp_net_amount:"31.53",gbp_vat_amount:"6.31",gbp_gross_amount:"37.84",vat_rate:"0.20"},config).reasons,[]);
  const mismatch=validateExpenseForQuickFile({...valid,gbp_net_amount:"5.82",gbp_vat_amount:"1.16",gbp_gross_amount:"6.98",vat_rate:"0.002"},config);
  assert.ok(mismatch.reasons.includes("vat_rate_amount_mismatch"));
  assert.deepEqual(mismatch.blockerDetails,[{code:"vat_rate_amount_mismatch",expense_id:expenseId,stored_rate:0.002,implied_rate:0.19931271}]);
  const zeroNet=validateExpenseForQuickFile({...valid,gbp_net_amount:"0",gbp_vat_amount:"2",gbp_gross_amount:"2",vat_rate:"0.20"},config);
  assert.ok(!zeroNet.reasons.includes("vat_rate_amount_mismatch"));
});

test("founder-funded paid purchases require their reviewed account mapping",()=>{
  assert.equal(validateExpenseForQuickFile(valid,config).row!.values["Paid account nominal code"],"3100");
  assert.ok(validateExpenseForQuickFile(valid,{...config,paymentAccountNominalCodes:{} }).reasons.includes("paid_account_nominal_code_missing:founder_director_funded"));
});

test("payment sources use controlled current values and founder compatibility aliases",()=>{
  assert.equal(resolvePaymentSource({founder_paid:true}),"founder_director_funded");
  assert.equal(resolvePaymentSource({paid_by:"founder",payment_channel:"KLPS PayPal funded by founder credit card"}),"founder_director_funded");
  assert.equal(resolvePaymentSource({payment_source:"paypal",founder_paid:true,paid_by:"founder"}),"paypal");
  assert.equal(resolvePaymentSource({payment_source:"other"}),"other");
  assert.equal(resolvePaymentSource({}),"unresolved");
  assert.equal(resolvePaymentSource({payment_channel:"PayPal funded by founder credit card"}),"unresolved");
});

test("legacy founder maps after normalization while absent payment source remains unresolved",()=>{
  const legacy=validateExpenseForQuickFile({...valid,founder_paid:null,paid_by:"founder",payment_channel:"KLPS PayPal funded by founder credit card"},config);
  assert.equal(legacy.row!.values["Paid account nominal code"],"3100");
  const unresolved=validateExpenseForQuickFile({...valid,founder_paid:null},config);
  assert.ok(unresolved.reasons.includes("payment_source_unresolved"));
  const other=validateExpenseForQuickFile({...valid,founder_paid:null,payment_source:"other"},{...config,paymentAccountNominalCodes:{...config.paymentAccountNominalCodes,other:"3101"}});
  assert.equal(other.row!.values["Paid account nominal code"],"3101");
});

const db=(expense={...valid},adjustments:Record<string,unknown>[]=[]):{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}=>({query:async(sql:string)=>{
  if(sql.includes("FROM finance_os.vat_periods"))return{rows:[{id:periodId,start_date:"2026-05-01",end_date:"2026-07-31",status:"open"}]};
  if(sql.includes("FROM finance_os.expenses e"))return{rows:[expense]};
  if(sql.includes("FROM finance_os.expense_adjustments"))return{rows:adjustments};
  if(sql.includes("INSERT INTO finance_os.finance_events"))return{rows:[]};
  throw new Error(`Unexpected SQL: ${sql}`);
}});

test("validation is provider-neutral, deterministic and reports manual refund handling",async()=>{
  const adjustments=[adjustment];
  const first=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,adjustments) as never);
  const second=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,adjustments) as never);
  assert.equal(first.export_type,MTD_EXPORT_TYPE);assert.equal(first.eligible_row_count,1);assert.equal(first.blocked_row_count,0);assert.equal(first.excluded_row_count,0);
  assert.equal(first.adjustment_handling.strategy,"exclude_from_purchase_csv_and_require_manual_credit_note");assert.equal(first.adjustment_handling.manual_adjustment_count,1);
  const item=first.adjustment_handling.items[0];assert.equal(item.gross_amount,"0.99");assert.equal(item.gbp_gross_amount,"0.99");assert.equal(item.adjustment_date,"2026-06-03");assert.equal(item.supplier_reference,"REFUND-1");assert.equal(item.parent_supplier_name,"Supplier Ltd");assert.equal(item.effective_parent_reference,"INV-1");assert.equal(item.included_in_primary_csv,false);
  assert.equal(first.blocked_row_count,0);assert.equal(first.eligible_row_count,1);
  assert.equal("r2_object_key" in item,false);assert.equal("evidence_files" in item,false);assert.equal("filename" in item,false);
  assert.equal(first.source_ledger_fingerprint,second.source_ledger_fingerprint);
});

test("insufficient supplier evidence is explicitly excluded and changes the source fingerprint",async()=>{
  const excluded={...valid,supplier_document_review_status:"insufficient_evidence_exclude_from_export"};
  const result=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(excluded) as never);
  assert.equal(result.eligible_row_count,0);assert.equal(result.blocked_row_count,0);assert.equal(result.excluded_row_count,1);
  assert.deepEqual(result.excluded_expense_ids,[expenseId]);
  assert.deepEqual(result.exclusion_reasons[expenseId],["supplier_document_insufficient_evidence"]);
  assert.deepEqual(result.rows,[]);
  const pending=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db({...valid,vat_treatment:"no_vat_shown",supplier_document_review_status:"pending_review"}) as never);
  assert.notEqual(result.source_ledger_fingerprint,pending.source_ledger_fingerprint);
});

test("manual adjustment reference resolution prefers commercial references then stable expense identity",()=>{
  assert.equal(manualAdjustmentProjection(adjustment).effective_parent_reference,"INV-1");
  assert.equal(manualAdjustmentProjection({...adjustment,parent_invoice_number:null}).effective_parent_reference,"ORDER-1");
  assert.equal(manualAdjustmentProjection({...adjustment,parent_invoice_number:null,parent_order_reference:null}).effective_parent_reference,"PAY-1");
  assert.equal(manualAdjustmentProjection({...adjustment,parent_invoice_number:null,parent_order_reference:null,parent_payment_reference:null}).effective_parent_reference,"expense-1");
});

test("adjustment changes alter the source fingerprint and stale generation is rejected",async()=>{
  const first=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,[adjustment]) as never);
  const changed={...adjustment,gbp_gross_amount:"1.00"};
  const second=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},config,db(valid,[changed]) as never);
  assert.notEqual(first.source_ledger_fingerprint,second.source_ledger_fingerprint);
  await assert.rejects(generateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE,expected_source_fingerprint:first.source_ledger_fingerprint},userId,config,db(valid,[changed]) as never),(error:unknown)=>(error as {code?:string}).code==="accounting_export_source_changed");
});

test("fingerprint mismatch blocks generation before returning CSV",async()=>{
  await assert.rejects(generateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE,expected_source_fingerprint:"0".repeat(64)},userId,config,db() as never),(error:unknown)=>(error as {code?:string}).code==="accounting_export_source_changed");
});

test("validation reports draft mapping provenance and generation blocks it",async()=>{
  const draft={id:"55555555-5555-4555-8555-555555555555",category_nominal_codes:{Software:"7001"},payment_account_nominal_codes:{founder_director_funded:"3100"},confirmed_at:null,updated_at:"2026-08-04",version:2};
  const base=db();const configured={query:async(sql:string,params?:unknown[])=>sql.includes("finance_os.accounting_export_configs")?{rows:[draft]}:base.query(sql,params)};
  const validation=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},undefined,configured as never);
  assert.equal(validation.mapping_config_source,"database");assert.equal(validation.mapping_config_confirmed,false);assert.equal(validation.mapping_config_version,2);
  await assert.rejects(generateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE,expected_source_fingerprint:validation.source_ledger_fingerprint},userId,undefined,configured as never),(error:unknown)=>(error as {code?:string}).code==="accounting_export_config_unconfirmed");
});

test("validation reports unmapped categories and payment sources",async()=>{
  const draft={id:"55555555-5555-4555-8555-555555555555",category_nominal_codes:{},payment_account_nominal_codes:{},confirmed_at:null,updated_at:"2026-08-04",version:1};
  const base=db();const configured={query:async(sql:string,params?:unknown[])=>sql.includes("finance_os.accounting_export_configs")?{rows:[draft]}:base.query(sql,params)};
  const validation=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},undefined,configured as never);
  assert.deepEqual(validation.missing_nominal_mappings,["Software"]);assert.deepEqual(validation.unmapped_payment_sources,["founder_director_funded"]);assert.equal(validation.blocked_row_count,1);
});

test("generation uses confirmed database mappings",async()=>{
  const confirmed={id:"55555555-5555-4555-8555-555555555555",category_nominal_codes:{Software:"7001"},payment_account_nominal_codes:{founder_director_funded:"3100"},confirmed_at:"2026-08-04",updated_at:"2026-08-04",version:3};
  const base=db();const configured={query:async(sql:string,params?:unknown[])=>sql.includes("finance_os.accounting_export_configs")?{rows:[confirmed]}:base.query(sql,params)};
  const validation=await validateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE},undefined,configured as never);
  const generated=await generateAccountingExport({vat_period_id:periodId,profile:QUICKFILE_PROFILE,expected_source_fingerprint:validation.source_ledger_fingerprint},userId,undefined,configured as never);
  assert.match(generated.csv,/Reviewed software purchase/);assert.equal(generated.validation.mapping_config_confirmed,true);assert.equal(generated.validation.mapped_nominal_codes.Software,"7001");
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
