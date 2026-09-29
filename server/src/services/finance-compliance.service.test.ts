import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveComplianceEventActions,deriveExpenseActions,derivePeriodActions, readinessState, reminderState } from "./finance-compliance.service";

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
  assert.match(routes,/router\.post\("\/compliance-events",requireFinanceWrite/);
  assert.match(routes,/router\.get\("\/compliance-events",requireFinanceWrite/);
});

test("HMRC penalty actions preserve one point, zero money due, and subjective review",()=>{
  const base={id:"22222222-2222-4222-8222-222222222222",event_type:"vat_late_submission_penalty",vat_period_id:"33333333-3333-4333-8333-333333333333",canonical_period_reference:"26A2",source_period_reference:"07 26",notice_date:"2026-09-18",event_date:"2026-09-15",reason:"Return not received",penalty_points:1,total_penalty_points:1,financial_penalty:"0.00",currency:"GBP",review_deadline:"2026-10-18",review_deadline_source_date:"2026-09-18",review_deadline_rule:"notice_date_plus_30_calendar_days",start_date:"2026-05-01",end_date:"2026-07-31",filing_deadline:"2026-09-07",filed:false};
  const actions=deriveComplianceEventActions(base);
  const submit=actions.find(action=>action.action_type==="submit_outstanding_vat_return");
  const review=actions.find(action=>action.action_type==="decide_hmrc_review");
  assert.equal(submit?.title,"Submit outstanding VAT return — 26A2");
  assert.equal(submit?.priority,"critical");assert.equal(submit?.is_machine_verifiable,true);
  assert.equal(review?.title,"Decide whether to request HMRC review — 26A2 penalty point");
  assert.equal(review?.due_date,"2026-10-18");assert.equal(review?.is_machine_verifiable,false);
  assert.equal(deriveComplianceEventActions({...base,filed:true}).some(action=>action.action_type==="submit_outstanding_vat_return"),false);
  assert.equal(deriveComplianceEventActions({...base,filed:true}).some(action=>action.action_type==="decide_hmrc_review"),true);
});

test("compliance migration is additive, structured, and never seeds or mutates VAT filings",()=>{
  const sql=readFileSync(path.resolve("server/sql/20260929_vat_penalty_compliance_events.sql"),"utf8");
  for(const field of ["event_type","vat_period_id","canonical_period_reference","source_period_reference","notice_date","event_date","penalty_points","total_penalty_points","financial_penalty","review_deadline","review_deadline_source_date","review_deadline_rule","dedupe_key"])assert.match(sql,new RegExp(field));
  assert.match(sql,/penalty_points >= 0/);assert.match(sql,/financial_penalty >= 0/);assert.match(sql,/vat_late_submission_penalty/);assert.match(sql,/compliance_event/);
  assert.doesNotMatch(sql,/INSERT INTO finance_os\.(compliance_events|vat_filings|finance_actions|evidence|evidence_links)/i);
  assert.doesNotMatch(sql,/ALTER TABLE finance_os\.vat_filings|UPDATE finance_os\.vat_filings|DELETE FROM finance_os\.vat_filings/i);
});

test("compliance event responses omit sensitive VAT identifiers and generic metadata",()=>{
  const service=readFileSync(path.resolve("server/src/services/finance-compliance.service.ts"),"utf8");
  const migration=readFileSync(path.resolve("server/sql/20260929_vat_penalty_compliance_events.sql"),"utf8");
  assert.doesNotMatch(migration,/vat_registration|registration_number|metadata jsonb/i);
  assert.doesNotMatch(service,/compliance_events[^`]*vat_registration/i);
  assert.match(service,/Unsupported compliance event fields/);
});
