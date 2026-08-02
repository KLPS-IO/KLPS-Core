import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHistoricalExpense,expenseWarnings,getVatLedger,resolveVatPeriod,suggestVatPeriod,updateHistoricalExpense } from "./finance-vat.service";

const user="22222222-2222-4222-8222-222222222222";
test("VAT Phase 1A migration is additive and seeds periods but no expenses",()=>{
  const sql=readFileSync("server/sql/20260801_finance_vat_phase1a.sql","utf8");
  assert.match(sql,/CREATE TABLE finance_os\.vat_periods/);
  assert.match(sql,/CREATE TABLE finance_os\.expense_adjustments/);
  assert.match(sql,/CREATE TABLE finance_os\.compliance_documents/);
  assert.doesNotMatch(sql,/INSERT INTO finance_os\.expenses/);
  assert.doesNotMatch(sql,/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  assert.match(sql,/'2025-05-08','2026-04-30'/);
  assert.match(sql,/'2026-05-01','2026-07-31'/);
});
test("historical expense creation uses approved defaults and decimals",async()=>{
  let query="",params:unknown[]=[];
  const db={query:async(q:string,p:unknown[])=>{query=q;params=p;return{rows:[{net_amount:"8.33",vat_amount:"1.67",gross_amount:"10.00",currency:"GBP"}]};}};
  await createHistoricalExpense({payment_date:"2025-05-08",supplier_name:"Supplier",gross_amount:"10.00",net_amount:"8.33",vat_amount:"1.67"},user,db as never);
  assert.match(query,/'Actual transaction','Pending Review','To Evidence'/);
  assert.equal(params.includes("10.00"),true);
});
test("VAT period boundaries are inclusive",async()=>{
  const db={query:async(_q:string,p:unknown[])=>({rows:p[0]==="2025-05-08"?[{id:"period"}]:[]})};
  assert.equal((await suggestVatPeriod("2025-05-08",db as never))?.id,"period");
  assert.equal(await suggestVatPeriod("2025-05-07",db as never),null);
});
test("VAT period suggestion reports overlapping periods as a conflict",async()=>{
  const db={query:async()=>({rows:[{id:"a"},{id:"b"}]})};
  const result=await suggestVatPeriod("2025-05-08",db as never);
  assert.equal(result?.vat_period_source,"conflict");
  assert.equal(result?.id,null);
});
test("canonical VAT period resolution prefers a valid explicit period",()=>{
  const periods=[
    {id:"period-a",start_date:"2025-05-08T00:00:00.000Z",end_date:"2026-04-30T00:00:00.000Z"},
    {id:"period-b",start_date:"2026-05-01",end_date:"2026-07-31"},
  ];
  assert.deepEqual(resolveVatPeriod({vat_period_id:"period-b",invoice_date:"2025-05-08",transaction_date:"2026-05-02"},periods),{
    stored_vat_period_id:"period-b",effective_vat_period_id:"period-b",vat_period_source:"explicit",effective_tax_point_date:"2025-05-08",matching_period_ids:["period-b"],
  });
});
test("canonical VAT period resolution derives by invoice, transaction, then payment date",()=>{
  const periods=[{id:"period-a",start_date:"2025-05-08",end_date:"2026-04-30"}];
  assert.equal(resolveVatPeriod({invoice_date:"2025-05-08T23:00:00-08:00",transaction_date:"2026-05-01",payment_date:"2026-05-02"},periods).effective_vat_period_id,"period-a");
  assert.equal(resolveVatPeriod({transaction_date:"2026-04-30T00:00:00.000Z"},periods).effective_vat_period_id,"period-a");
  assert.equal(resolveVatPeriod({payment_date:"2025-05-08"},periods).effective_vat_period_id,"period-a");
});
test("canonical VAT period resolution reports none and overlapping conflicts without choosing",()=>{
  assert.equal(resolveVatPeriod({transaction_date:"2025-05-07"},[{id:"period",start_date:"2025-05-08",end_date:"2026-04-30"}]).vat_period_source,"none");
  const conflict=resolveVatPeriod({transaction_date:"2025-05-08"},[
    {id:"a",start_date:"2025-05-01",end_date:"2025-05-31"},
    {id:"b",start_date:"2025-05-08",end_date:"2025-06-30"},
  ]);
  assert.equal(conflict.vat_period_source,"conflict");
  assert.equal(conflict.effective_vat_period_id,null);
});
test("VAT ledger filtering includes explicit and derived rows but excludes archived rows in SQL",async()=>{
  const periodId="11111111-1111-4111-8111-111111111111";
  const periods=[{id:periodId,start_date:"2025-05-08",end_date:"2026-04-30"}];
  const queries:string[]=[];
  const db={query:async(q:string)=>{queries.push(q);return queries.length===1?{rows:periods}:{rows:[
    {id:"explicit",vat_period_id:periodId,transaction_date:"2025-01-01",supplier_name:"A",gross_amount:"1",evidence_files:[]},
    {id:"derived",vat_period_id:null,transaction_date:"2025-05-08",supplier_name:"B",gross_amount:"2",evidence_files:[]},
    {id:"outside",vat_period_id:null,transaction_date:"2025-05-07",supplier_name:"C",gross_amount:"3",evidence_files:[]},
  ]};}};
  const rows=await getVatLedger(periodId,db as never);
  assert.deepEqual(rows.map(row=>row.id),["explicit","derived"]);
  assert.deepEqual(rows.map(row=>row.vat_period_source),["explicit","derived"]);
  assert.match(queries[1],/archived_at IS NULL/);
  assert.match(queries[1],/transaction_date::text AS transaction_date/);
  assert.doesNotMatch(queries[1],/UPDATE|INSERT/);
});
test("warnings preserve save but review complete is blocked",async()=>{
  assert.deepEqual(expenseWarnings({gbp_net_amount:"10",gbp_vat_amount:"2",gbp_gross_amount:"11",currency:"USD"}),["gross_net_vat_mismatch","foreign_currency_without_conversion","pending_vat_treatment","supplier_country_missing"]);
  let queries=0;const db={query:async()=>{queries++;return{rows:[{gbp_net_amount:"10",gbp_vat_amount:"2",gbp_gross_amount:"11"}]};}};
  await assert.rejects(updateHistoricalExpense("11111111-1111-4111-8111-111111111111",{vat_review_status:"review_complete",change_reason:"review"},user,db as never),/Critical warnings/);
  assert.equal(queries,1,"blocked review must not reach UPDATE");
});
test("pending VAT treatment warns until a controlled treatment is selected",()=>{
  assert.ok(expenseWarnings({currency:"GBP",vat_treatment:null,supplier_country:"GB"}).includes("pending_vat_treatment"));
  assert.ok(expenseWarnings({currency:"GBP",vat_treatment:"pending_review",supplier_country:"GB"}).includes("pending_vat_treatment"));
  assert.ok(!expenseWarnings({currency:"GBP",vat_treatment:"standard_rated",supplier_country:"GB"}).includes("pending_vat_treatment"));
});
test("foreign currency accepts a recorded rate or complete manual GBP values with a note",()=>{
  const warning="foreign_currency_without_conversion";
  assert.ok(expenseWarnings({currency:"EUR",gross_amount:"10",vat_treatment:"pending_review"}).includes(warning));
  assert.ok(!expenseWarnings({currency:"EUR",gross_amount:"10",exchange_rate:"0.85",gbp_net_amount:"7",gbp_vat_amount:"1.50",gbp_gross_amount:"8.50",vat_treatment:"pending_review"}).includes(warning));
  assert.ok(!expenseWarnings({currency:"EUR",gbp_net_amount:"7",gbp_vat_amount:"1.50",gbp_gross_amount:"8.50",notes:"Founder-entered GBP conversion",vat_treatment:"pending_review"}).includes(warning));
  assert.ok(expenseWarnings({currency:"EUR",gbp_net_amount:"7",gbp_vat_amount:"1.50",gbp_gross_amount:"8.50",vat_treatment:"pending_review"}).includes(warning));
  assert.ok(expenseWarnings({currency:"EUR",gbp_net_amount:"7",gbp_gross_amount:"8.50",notes:"Incomplete manual conversion",vat_treatment:"pending_review"}).includes(warning));
  assert.ok(!expenseWarnings({currency:"GBP",vat_treatment:"pending_review"}).includes(warning));
  const mismatched=expenseWarnings({currency:"EUR",gbp_net_amount:"7",gbp_vat_amount:"2",gbp_gross_amount:"8.50",notes:"Mismatched manual conversion",vat_treatment:"pending_review"});
  assert.ok(mismatched.includes("gross_net_vat_mismatch"));
  assert.ok(mismatched.includes(warning));
});
test("negative monetary values and invalid treatment are rejected",async()=>{
  const db={query:async()=>({rows:[]})};
  await assert.rejects(createHistoricalExpense({payment_date:"2025-05-08",supplier_name:"Supplier",gross_amount:"-1"},user,db as never));
  await assert.rejects(updateHistoricalExpense("11111111-1111-4111-8111-111111111111",{vat_treatment:"automatic_decision",change_reason:"x"},user,db as never));
});
test("VAT API remains additive and preserves existing routes and working-paper label",()=>{
  const routes=readFileSync("server/src/routes/finance.routes.ts","utf8");
  assert.match(routes,/router\.get\("\/vat-periods"/);
  assert.match(routes,/router\.get\("\/vat-ledger"/);
  assert.match(routes,/router\.post\("\/expenses"/);
  assert.match(routes,/VAT working paper – not an HMRC submission/);
  assert.match(routes,/router\.get\(\s*"\/state"/);
});
