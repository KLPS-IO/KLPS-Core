import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHistoricalExpense,expenseWarnings,suggestVatPeriod,updateHistoricalExpense } from "./finance-vat.service";

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
test("warnings preserve save but review complete is blocked",async()=>{
  assert.deepEqual(expenseWarnings({gbp_net_amount:"10",gbp_vat_amount:"2",gbp_gross_amount:"11",currency:"USD"}),["gross_net_vat_mismatch","foreign_currency_without_conversion","supplier_country_missing"]);
  const db={query:async()=>({rows:[{gbp_net_amount:"10",gbp_vat_amount:"2",gbp_gross_amount:"11"}]})};
  await assert.rejects(updateHistoricalExpense("11111111-1111-4111-8111-111111111111",{vat_review_status:"review_complete",change_reason:"review"},user,db as never),/Critical warnings/);
});
test("negative monetary values and invalid treatment are rejected",async()=>{
  const db={query:async()=>({rows:[]})};
  await assert.rejects(createHistoricalExpense({payment_date:"2025-05-08",supplier_name:"Supplier",gross_amount:"-1"},user,db as never));
  await assert.rejects(updateHistoricalExpense("11111111-1111-4111-8111-111111111111",{vat_treatment:"automatic_decision",change_reason:"x"},user,db as never));
});
