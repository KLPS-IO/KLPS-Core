import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getCompany,
  getCompanyHealth,
  updateCompany,
  validateCompanyUpdate
} from "./company.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const canonical = {
  id: COMPANY_ID,
  company_number: "16436591",
  corporation_tax_status: "Unknown",
  accounting_method: "Unknown",
  ico_status: "Not Started",
  seis_status: "Preparing",
  business_bank_status: "Application Pending",
  crl: null,
  version: 1
};

test("company migration enforces company-number uniqueness", () => {
  const migration = readFileSync(join(process.cwd(), "server/sql/20260722_canonical_company.sql"), "utf8");
  assert.match(migration, /company_number text NOT NULL UNIQUE/);
  assert.match(migration, /ON CONFLICT \(company_number\) DO NOTHING/);
});

test("canonical seeded company retrieval uses the singular company table", async () => {
  let sql = "";
  const company = await getCompany({ query: async (query: string) => {
    sql = query;
    return { rows: [canonical] };
  }} as never);
  assert.match(sql, /FROM finance_os\.company/);
  assert.equal(company.company_number, "16436591");
});

test("company update validates controlled statuses and TRL/CRL ranges", () => {
  assert.throws(() => validateCompanyUpdate({ change_reason: "Review", company_status: "Maybe" }), /Invalid company_status/);
  assert.throws(() => validateCompanyUpdate({ change_reason: "Review", trl: 0 }), /Invalid trl/);
  assert.throws(() => validateCompanyUpdate({ change_reason: "Review", crl: 10 }), /Invalid crl/);
  assert.equal(validateCompanyUpdate({ change_reason: "Review", crl: null }).crl, null);
});

test("company update requires change_reason", () => {
  assert.throws(() => validateCompanyUpdate({ trading_name: "KLPS" }), /change_reason is required/);
});

test("company updates snapshot the previous version and increment audit version", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    if (queries.length === 1) return { rows: [canonical] };
    if (queries.length === 2) return { rows: [{}] };
    return { rows: [{ ...canonical, trading_name: "KLPS UK", version: 2, updated_by: USER_ID }] };
  }};
  const company = await updateCompany({ trading_name: "KLPS UK", change_reason: "Brand review" }, USER_ID, db as never);
  assert.match(queries[0], /FOR UPDATE/);
  assert.match(queries[1], /company_versions/);
  assert.match(queries[2], /updated_by/);
  assert.equal(company.version, 2);
  assert.equal(company.updated_by, USER_ID);
});

test("company health reports each unresolved canonical readiness item", async () => {
  let call = 0;
  const health = await getCompanyHealth({ query: async () => {
    call += 1;
    return call === 1 ? { rows: [canonical] } : { rows: [] };
  }} as never);
  assert.equal(health.completion_percentage, 0);
  assert.equal(health.verified_field_count, 0);
  assert.equal(health.unknown_field_count, 7);
  assert.deepEqual(health.warnings.map(item => item.code), [
    "CORPORATION_TAX_UNKNOWN", "ACCOUNTING_METHOD_UNKNOWN", "ICO_NOT_REGISTERED",
    "SEIS_NOT_SUBMITTED", "BANK_NOT_OPEN", "CRL_NOT_CONFIRMED", "NO_COMPANY_EVIDENCE"
  ]);
});
