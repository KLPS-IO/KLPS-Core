import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveExpenseActions,derivePeriodActions, readinessState, reminderState } from "./finance-compliance.service";

test("filing existence is the only submitted readiness input",()=>{
  assert.equal(readinessState({filed:true,deadline:"2026-06-30",today:"2026-08-09",blockers:5,validated:false,exported:false,started:true}),"SUBMITTED");
  assert.equal(readinessState({filed:false,deadline:"2026-06-30",today:"2026-08-09",blockers:0,validated:true,exported:true,started:true}),"OVERDUE");
});

test("readiness progression is deterministic",()=>{
  const base={filed:false,deadline:"2026-09-07",today:"2026-08-09",started:true};
  assert.equal(readinessState({...base,blockers:1,validated:false,exported:false}),"BLOCKED");
  assert.equal(readinessState({...base,blockers:0,validated:true,exported:false}),"READY_TO_EXPORT");
  assert.equal(readinessState({...base,blockers:0,validated:true,exported:true}),"EXPORTED_NOT_FILED");
  assert.equal(readinessState({...base,blockers:0,validated:false,exported:false}),"IN_REVIEW");
});

test("reminders cover all approved thresholds and overdue",()=>{
  for(const [date,milestone] of [["2026-09-08",30],["2026-08-30",21],["2026-08-23",14],["2026-08-19",10],["2026-08-16",7],["2026-08-12",3],["2026-08-10",1],["2026-08-09",0]] as const)assert.equal(reminderState(date,"2026-08-09").milestone,milestone);
  assert.equal(reminderState("2026-08-08","2026-08-09").milestone,"overdue");
});

test("system action keys are stable and subjective actions are not machine-verifiable",()=>{
  const period={id:"a03ac4c1-f4cc-4699-8515-71bda1f31593",start_date:"2026-05-01",end_date:"2026-07-31",filing_deadline:"2026-09-07",readiness_state:"EXPORTED_NOT_FILED",blocker_count:0};
  const first=derivePeriodActions(period),second=derivePeriodActions(period);
  assert.deepEqual(first.map(x=>x.dedupe_key),second.map(x=>x.dedupe_key));
  assert.equal(new Set(first.map(x=>x.dedupe_key)).size,first.length);
  for(const type of ["quickfile_reconciliation","founder_final_review","confirm_vat_filing"])assert.equal(first.find(x=>x.action_type===type)?.is_machine_verifiable,false);
});

test("expense conditions produce machine actions while supplier judgement stays founder-controlled",()=>{
  const actions=deriveExpenseActions([{id:"11111111-1111-4111-8111-111111111111",category:"To Classify",payment_source:null,evidence_files:[],warnings:["vat_period_date_conflict"],supplier_document_review_status:"pending_review"}]);
  assert.equal(actions.find(x=>x.action_type==="resolve_vat_period_conflict")?.priority,"critical");
  assert.equal(actions.find(x=>x.action_type==="supplier_document_judgement")?.is_machine_verifiable,false);
  assert.ok(actions.filter(x=>x.is_machine_verifiable).length>=4);
});

test("migration corrects deadline, seeds 26A3, and never seeds 25YE filing",()=>{
  const sql=readFileSync(path.resolve("server/sql/20260809_finance_compliance.sql"),"utf8");
  assert.match(sql,/2026-06-30/);assert.match(sql,/2026-08-01/);assert.match(sql,/2026-10-31/);assert.match(sql,/2026-12-07/);
  assert.doesNotMatch(sql,/25YE/);assert.doesNotMatch(sql,/INSERT INTO finance_os\.vat_filings/i);
  assert.match(sql,/reject_vat_filing_mutation/);
});

test("compliance mutation and filing routes are founder-only",()=>{
  const routes=readFileSync(path.resolve("server/src/routes/finance.routes.ts"),"utf8");
  assert.match(routes,/router\.post\("\/actions\/refresh",requireFinanceWrite/);
  assert.match(routes,/router\.post\("\/vat-filings",requireFinanceWrite/);
  assert.match(routes,/router\.get\("\/compliance",requireFinanceWrite/);
});
