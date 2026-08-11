import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { FILING_EVIDENCE_PURPOSES, LINKED_ENTITY_TYPES, VAT_EVIDENCE_TYPES, validateEvidenceInput } from "./evidence.service";

const migration=readFileSync(path.resolve("server/sql/20260811_vat_filing_evidence.sql"),"utf8");
const rollback=readFileSync(path.resolve("server/sql/20260811_vat_filing_evidence.rollback.sql"),"utf8");
const routes=readFileSync(path.resolve("server/src/routes/finance.routes.ts"),"utf8");
const compliance=readFileSync(path.resolve("server/src/services/finance-compliance.service.ts"),"utf8");
const evidence=readFileSync(path.resolve("server/src/services/evidence.service.ts"),"utf8");
const upload=readFileSync(path.resolve("server/src/services/document-upload.service.ts"),"utf8");

test("VAT filing is a canonical evidence-link type with a guarded rollback",()=>{
  assert.ok(LINKED_ENTITY_TYPES.includes("vat_filing"));
  assert.match(migration,/evidence_links_entity_type_check[\s\S]*'vat_filing'/);
  assert.match(rollback,/Cannot roll back VAT filing evidence while filing links exist/);
  assert.doesNotMatch(migration,/INSERT INTO finance_os\.(vat_filings|evidence|evidence_links)/i);
});

test("filing purposes are controlled separately from expense VAT evidence",()=>{
  for(const purpose of ["hmrc_submitted_vat_return","vat_return_submission_confirmation","vat_return_calculation_export","vat_return_filed_summary"])assert.ok(FILING_EVIDENCE_PURPOSES.includes(purpose as typeof FILING_EVIDENCE_PURPOSES[number]));
  assert.ok(FILING_EVIDENCE_PURPOSES.every(purpose=>!VAT_EVIDENCE_TYPES.includes(purpose as typeof VAT_EVIDENCE_TYPES[number])));
  assert.equal(validateEvidenceInput({title:"Return",evidence_type:"document",filing_evidence_purpose:"hmrc_submitted_vat_return"}).filing_evidence_purpose,"hmrc_submitted_vat_return");
  assert.throws(()=>validateEvidenceInput({title:"Return",evidence_type:"document",filing_evidence_purpose:"full_vat_invoice"}),/Invalid filing_evidence_purpose/);
});

test("filing uploads require a fixed complete link tuple and controlled purpose",()=>{
  assert.match(upload,/linked_entity_type", "linked_entity_id", "relationship"/);
  assert.match(upload,/filing_evidence_purpose is required for VAT filing evidence/);
  assert.match(upload,/filing_evidence_purpose requires a VAT filing link/);
  assert.match(upload,/filingEvidencePurpose/);
});

test("filing evidence is founder-only, receipt-redacted, audited safely and unlinked without deleting evidence",()=>{
  assert.match(routes,/"\/evidence\/upload",\s*requireFinanceWrite/);
  assert.match(routes,/vat_filing_evidence_linked/);assert.match(routes,/vat_filing_evidence_unlinked/);
  assert.match(routes,/remaining_link_count:result\.remaining_link_count/);assert.doesNotMatch(routes,/jsonOk\(result\)/);
  assert.match(compliance,/true AS hmrc_receipt_recorded/);assert.match(compliance,/filing_evidence_purpose/);
  assert.match(evidence,/selectedLink\.entity_type === "vat_filing"[\s\S]*DELETE FROM finance_os\.evidence_links/);
  assert.doesNotMatch(evidence,/selectedLink\.entity_type === "vat_filing"[\s\S]{0,500}DELETE FROM finance_os\.evidence WHERE/);
});

test("immutable VAT filing triggers remain untouched",()=>{
  const original=readFileSync(path.resolve("server/sql/20260809_finance_compliance.sql"),"utf8");
  assert.match(original,/vat_filings_immutable_update/);assert.match(original,/vat_filings_immutable_delete/);
  assert.doesNotMatch(migration,/DROP TRIGGER|ALTER TABLE finance_os\.vat_filings|UPDATE finance_os\.vat_filings|DELETE FROM finance_os\.vat_filings/);
});
