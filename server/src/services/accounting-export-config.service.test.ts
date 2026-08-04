/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getAccountingExportConfig,
  resolveAccountingExportConfig,
  validateAccountingExportConfigInput
} from "./accounting-export-config.service";

const profile="quickfile_purchase_csv_v1";
const environment={categoryNominalCodes:{Software:"7001"},paymentAccountNominalCodes:{paypal:"1201"}};
const db=(row?:Record<string,unknown>)=>({query:async()=>({rows:row?[row]:[]})});

test("no saved configuration and no environment fallback returns an unmapped contract",async()=>{
  const result=await getAccountingExportConfig(profile,db() as never,{categoryNominalCodes:{},paymentAccountNominalCodes:{}});
  assert.equal(result.source,"none");assert.equal(result.confirmed,false);assert.equal(result.version,0);assert.deepEqual(result.category_nominal_codes,{});
});

test("environment mappings are a fallback only when no database row exists",async()=>{
  const result=await getAccountingExportConfig(profile,db() as never,environment);
  assert.equal(result.source,"environment");assert.equal(result.confirmed,false);assert.deepEqual(result.category_nominal_codes,{Software:"7001"});
});

test("draft database configuration overrides environment without becoming generation-ready",async()=>{
  const row={id:"1",category_nominal_codes:{Hardware:"5001"},payment_account_nominal_codes:{business_bank:"1200"},confirmed_at:null,updated_at:"2026-08-04",version:2};
  const result=await resolveAccountingExportConfig(profile,db(row) as never,environment);
  assert.equal(result.source,"database");assert.equal(result.confirmed,false);assert.equal(result.usableForGeneration,false);assert.deepEqual(result.config.categoryNominalCodes,{Hardware:"5001"});
});

test("confirmed database configuration is generation-ready",async()=>{
  const row={id:"1",category_nominal_codes:{Hardware:"5001"},payment_account_nominal_codes:{business_bank:"1200"},confirmed_at:"2026-08-04",updated_at:"2026-08-04",version:3};
  const result=await resolveAccountingExportConfig(profile,db(row) as never,environment);
  assert.equal(result.confirmed,true);assert.equal(result.usableForGeneration,true);assert.equal(result.version,3);
});

test("configuration input trims mappings and rejects empty or unsupported payment values",()=>{
  const valid=validateAccountingExportConfigInput({profile,category_nominal_codes:{" Prototype materials ":" 5001 "},payment_account_nominal_codes:{paypal:" 1201 "},confirm:false,expected_version:0,change_reason:" Draft mappings "});
  assert.deepEqual(valid.category,{"Prototype materials":"5001"});assert.deepEqual(valid.payment,{paypal:"1201"});
  assert.throws(()=>validateAccountingExportConfigInput({profile,category_nominal_codes:{Software:""},payment_account_nominal_codes:{},confirm:false,expected_version:0,change_reason:"x"}));
  assert.throws(()=>validateAccountingExportConfigInput({profile,category_nominal_codes:{},payment_account_nominal_codes:{cash:"1000"},confirm:true,expected_version:0,change_reason:"x"}),(error:unknown)=>(error as {code?:string}).code==="unsupported_payment_mapping_key");
});

test("migration is additive, constrained, versioned and rollback-owned",()=>{
  const migration=readFileSync("server/sql/20260806_mtd_accounting_export_configs.sql","utf8");
  const rollback=readFileSync("server/sql/20260806_mtd_accounting_export_configs.rollback.sql","utf8");
  assert.match(migration,/^BEGIN;/m);assert.match(migration,/CREATE TABLE finance_os\.accounting_export_configs/);assert.match(migration,/UNIQUE\(export_type,profile\)/);
  assert.match(migration,/accounting_export_config_versions/);assert.match(migration,/append-only/);assert.match(migration,/^COMMIT;/m);
  assert.match(rollback,/DROP TABLE IF EXISTS finance_os\.accounting_export_config_versions/);assert.match(rollback,/DROP TABLE IF EXISTS finance_os\.accounting_export_configs/);
  assert.doesNotMatch(migration,/ALTER TABLE finance_os\.expenses/);assert.doesNotMatch(rollback,/finance_os\.expenses/);
});

test("routes are founder-only and configuration audit events are explicit",()=>{
  const routes=readFileSync("server/src/routes/finance.routes.ts","utf8");
  const service=readFileSync("server/src/services/accounting-export-config.service.ts","utf8");
  assert.match(routes,/router\.get\("\/accounting-exports\/config",requireFinanceWrite/);assert.match(routes,/router\.put\("\/accounting-exports\/config",requireFinanceWrite/);
  for(const event of ["accounting_export_config_saved","accounting_export_config_confirmed","accounting_export_config_validation_failed","accounting_export_config_version_conflict"])assert.match(service,new RegExp(event));
  assert.match(service,/actual!==expected/);assert.match(service,/statusCode|409/);
});
