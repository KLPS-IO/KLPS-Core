import test from "node:test";
import assert from "node:assert/strict";
import {
  createEvidence,
  getEvidence,
  linkEvidence,
  listEvidence,
  updateEvidence,
  validateEvidenceInput
} from "./evidence.service";
import { requireFinanceWrite } from "../routes/finance.routes";
import {
  buildDocumentStorage,
  parseDocumentUploadInput
} from "./document-upload.service";

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

test("clients cannot submit backend-managed storage or naming fields", () => {
  for (const field of ["folder_path", "r2_object_key", "evidence_code", "file_version", "storage_provider"]) {
    assert.throws(
      () => validateEvidenceInput({ title: "x", evidence_type: "document", [field]: "chosen-by-client" }),
      /Backend-managed fields are not accepted/
    );
  }
});

test("document upload linking is all-or-nothing", () => {
  assert.throws(
    () => parseDocumentUploadInput({ title: "Pack", document_category: "Finance", linked_entity_type: "company" }),
    (reason: unknown) => (reason as { code?: string }).code === "partial_entity_link"
  );
  const unlinked = parseDocumentUploadInput({ title: "Pack", document_category: "Finance", document_date: "2026-07-11" });
  assert.equal(unlinked.linkedEntityType, null);
  const linked = parseDocumentUploadInput({
    title: "Pack", document_category: "Finance", document_date: "2026-07-11",
    linked_entity_type: "company", linked_entity_id: ENTITY_ID, relationship: "supports"
  });
  assert.equal(linked.relationship, "supports");
});

test("document storage naming follows the canonical Finance OS mapping", () => {
  assert.deepEqual(
    buildDocumentStorage("Finance", "EVD-0003", "HMRC VAT Registration Approval", "2026-07-11", "source.PDF"),
    {
      folder: "02_FINANCE",
      filename: "EVD-0003_HMRC-VAT-Registration-Approval_2026-07-11_v1.pdf",
      objectKey: "02_FINANCE/EVD-0003_HMRC-VAT-Registration-Approval_2026-07-11_v1.pdf"
    }
  );
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

const COMPANY_LINK = {
  id: "44444444-4444-4444-8444-444444444444",
  evidence_id: EVIDENCE_ID,
  entity_type: "company",
  entity_id: ENTITY_ID,
  relationship: "Supports company formation and ownership",
  notes: null,
  created_at: "2026-07-23T10:00:00.000Z"
};

test("list evidence always returns links as an empty array when no links exist", async () => {
  const db = { query: async () => ({ rows: [{ id: EVIDENCE_ID, title: "Unlinked", links: null }] }) };
  const rows = await listEvidence({}, db as never);
  assert.deepEqual(rows, [{ id: EVIDENCE_ID, title: "Unlinked", links: [] }]);
});

test("list evidence returns one canonical Company link", async () => {
  const db = { query: async () => ({ rows: [{ id: EVIDENCE_ID, links: [COMPANY_LINK] }] }) };
  const rows = await listEvidence({}, db as never);
  assert.equal(rows[0].links.length, 1);
  assert.deepEqual(rows[0].links[0], COMPANY_LINK);
});

test("list evidence returns one evidence row with all canonical links", async () => {
  let sql = "";
  const secondLink = {
    ...COMPANY_LINK,
    id: "55555555-5555-4555-8555-555555555555",
    entity_type: "assumption",
    entity_id: "66666666-6666-4666-8666-666666666666",
    relationship: "supports"
  };
  const db = { query: async (query: string) => {
    sql = query;
    return { rows: [{ id: EVIDENCE_ID, links: [COMPANY_LINK, secondLink] }] };
  }};
  const rows = await listEvidence({}, db as never);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].links, [COMPANY_LINK, secondLink]);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /jsonb_agg\(canonical_link ORDER BY canonical_link\.created_at\)/);
  assert.doesNotMatch(sql, /SELECT DISTINCT/);
});

test("list evidence preserves filters, descending ordering, and bounded limit", async () => {
  let sql = "";
  let params: unknown[] = [];
  const db = { query: async (query: string, values?: unknown[]) => {
    sql = query;
    params = values ?? [];
    return { rows: [] };
  }};
  await listEvidence({
    title: "formation",
    category: "Corporate",
    evidence_type: "document",
    linked_entity_type: "company",
    linked_entity_id: ENTITY_ID,
    limit: 9999
  }, db as never);
  assert.match(sql, /e\.title ILIKE/);
  assert.match(sql, /e\.document_category = \$2/);
  assert.match(sql, /e\.evidence_type = \$3/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM finance_os\.evidence_links filtered_link/);
  assert.match(sql, /ORDER BY e\.created_at DESC LIMIT \$6/);
  assert.deepEqual(params, ["formation", "Corporate", "document", "company", ENTITY_ID, 500]);
});

test("list and detail use the same canonical link representation", async () => {
  const queries: string[] = [];
  const db = { query: async (query: string) => {
    queries.push(query);
    return { rows: [{ id: EVIDENCE_ID, links: [COMPANY_LINK] }] };
  }};
  const listed = await listEvidence({}, db as never);
  const detailed = await getEvidence(EVIDENCE_ID, db as never);
  assert.deepEqual(listed[0].links, detailed.links);
  assert.deepEqual(Object.keys(listed[0].links[0]), Object.keys(detailed.links[0]));
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query, /COALESCE\(canonical_links\.links, '\[\]'::jsonb\) AS links/);
    assert.match(query, /FROM finance_os\.evidence_links canonical_link/);
  }
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

test("company evidence links validate the canonical company target", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    if (queries.length === 1) return { rows: [{ id: EVIDENCE_ID }] };
    if (queries.length === 2) return { rows: [{ id: ENTITY_ID }] };
    return { rows: [{ id: "44444444-4444-4444-8444-444444444444", entity_type: "company", entity_id: ENTITY_ID }] };
  }};
  const link = await linkEvidence(EVIDENCE_ID, { entity_type: "company", entity_id: ENTITY_ID }, USER_ID, db as never);
  assert.match(queries[1], /finance_os\.company/);
  assert.equal(link.entity_type, "company");
});

test("missing company evidence targets return not found instead of unsupported", async () => {
  let call = 0;
  const db = { query: async () => {
    call += 1;
    return call === 1 ? { rows: [{ id: EVIDENCE_ID }] } : { rows: [] };
  }};
  await assert.rejects(
    linkEvidence(EVIDENCE_ID, { entity_type: "company", entity_id: ENTITY_ID }, USER_ID, db as never),
    (reason: unknown) => (reason as { code?: string; statusCode?: number }).code === "linked_entity_not_found" && (reason as { statusCode?: number }).statusCode === 404
  );
});

test("duplicate company evidence links return conflict", async () => {
  let call = 0;
  const db = { query: async () => {
    call += 1;
    if (call <= 2) return { rows: [{ id: call === 1 ? EVIDENCE_ID : ENTITY_ID }] };
    throw Object.assign(new Error("duplicate"), { code: "23505" });
  }};
  await assert.rejects(
    linkEvidence(EVIDENCE_ID, { entity_type: "company", entity_id: ENTITY_ID }, USER_ID, db as never),
    (reason: unknown) => (reason as { code?: string; statusCode?: number }).code === "duplicate_evidence_link" && (reason as { statusCode?: number }).statusCode === 409
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
