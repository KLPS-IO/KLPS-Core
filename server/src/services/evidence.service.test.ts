import test from "node:test";
import assert from "node:assert/strict";
import {
  createEvidence,
  linkEvidence,
  updateEvidence,
  validateEvidenceInput
} from "./evidence.service";
import { requireFinanceWrite } from "../routes/finance.routes";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const ENTITY_ID = "33333333-3333-4333-8333-333333333333";

test("evidence validation accepts canonical controlled values and audit reason", () => {
  const value = validateEvidenceInput({
    title: "Board pack",
    evidence_type: "research",
    document_category: "Corporate",
    verification_status: "Verified",
    document_status: "Active",
    confidence: 0.9,
    change_reason: "Reviewed by founder"
  });
  assert.equal(value.document_category, "Corporate");
  assert.equal(value.verification_status, "Verified");
  assert.equal(value.change_reason, "Reviewed by founder");
});

test("evidence validation rejects invalid categories and statuses", () => {
  assert.throws(() => validateEvidenceInput({ title: "x", evidence_type: "research", document_category: "Other" }), /Invalid document_category/);
  assert.throws(() => validateEvidenceInput({ title: "x", evidence_type: "research", verification_status: "Maybe" }), /Invalid verification_status/);
  assert.throws(() => validateEvidenceInput({ title: "x", evidence_type: "research", document_status: "Deleted" }), /Invalid document_status/);
});

test("create evidence delegates evidence-code generation to PostgreSQL and sets audit users", async () => {
  let sql = "";
  let params: unknown[] = [];
  const db = { query: async (query: string, values?: unknown[]) => {
    sql = query; params = values ?? [];
    return { rows: [{ id: EVIDENCE_ID, evidence_code: "EVD-0001", created_by: USER_ID, updated_by: USER_ID }] };
  }};
  const row = await createEvidence({ title: "Pack", evidence_type: "research" }, USER_ID, db as never);
  assert.doesNotMatch(sql, /evidence_code/);
  assert.match(sql, /created_by, updated_by/);
  assert.equal(params[params.length - 1], USER_ID);
  assert.equal(row.evidence_code, "EVD-0001");
});

test("duplicate entity links return a conflict instead of updating the existing link", async () => {
  let call = 0;
  const db = { query: async () => {
    call += 1;
    if (call === 1) return { rows: [{ id: EVIDENCE_ID }] };
    if (call === 2) return { rows: [{ id: ENTITY_ID }] };
    throw Object.assign(new Error("duplicate"), { code: "23505" });
  }};
  await assert.rejects(
    linkEvidence(EVIDENCE_ID, { entity_type: "assumption", entity_id: ENTITY_ID }, USER_ID, db as never),
    (reason: unknown) => (reason as { code?: string; statusCode?: number }).code === "duplicate_evidence_link" && (reason as { statusCode?: number }).statusCode === 409
  );
});

test("missing linked entities are rejected", async () => {
  let call = 0;
  const db = { query: async () => {
    call += 1;
    return call === 1 ? { rows: [{ id: EVIDENCE_ID }] } : { rows: [] };
  }};
  await assert.rejects(
    linkEvidence(EVIDENCE_ID, { entity_type: "risk", entity_id: ENTITY_ID }, USER_ID, db as never),
    (reason: unknown) => (reason as { code?: string }).code === "linked_entity_not_found"
  );
});

test("updates snapshot the prior version and set update audit fields", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    if (queries.length === 1) return { rows: [{ id: EVIDENCE_ID }] };
    if (queries.length === 2) return { rows: [{ id: EVIDENCE_ID, version: 2, links: [] }] };
    if (queries.length === 3) return { rows: [{}] };
    return { rows: [{ id: EVIDENCE_ID, version: 3, updated_by: USER_ID }] };
  }};
  const row = await updateEvidence(EVIDENCE_ID, { title: "Updated", change_reason: "Annual review" }, USER_ID, db as never);
  assert.match(queries[0], /FOR UPDATE/);
  assert.match(queries[2], /evidence_versions/);
  assert.match(queries[3], /updated_by/);
  assert.equal(row.version, 3);
  assert.equal(row.updated_by, USER_ID);
});

test("Finance OS writes require founder/admin access", () => {
  let status = 0;
  let body: unknown;
  let nextCalled = false;
  const response = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; }
  };
  requireFinanceWrite(
    { dataRoomUser: { id: USER_ID, email: "guest@example.com", role: "authorised_user", accessTier: "investor_nda" } } as never,
    response as never,
    (() => { nextCalled = true; }) as never
  );
  assert.equal(status, 403);
  assert.equal((body as { code: string }).code, "finance_write_forbidden");
  assert.equal(nextCalled, false);

  requireFinanceWrite(
    { dataRoomUser: { id: USER_ID, email: "founder@example.com", role: "founder_admin", accessTier: "admin_only" } } as never,
    response as never,
    (() => { nextCalled = true; }) as never
  );
  assert.equal(nextCalled, true);
});
