import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

export const DOCUMENT_CATEGORIES = [
  "Read First", "Corporate", "Finance", "Fundraising", "Product", "Technology",
  "Intellectual Property", "Manufacturing", "Market", "Customers",
  "Research", "Regulatory", "Legal", "Team", "Press", "Archive"
] as const;
export const VERIFICATION_STATUSES = [
  "Unknown", "Unverified", "Under Review", "Verified", "Rejected", "Expired"
] as const;
export const DOCUMENT_STATUSES = [
  "Draft", "Active", "Superseded", "Archived", "Expired"
] as const;
export const EVIDENCE_TYPES = [
  "supplier_quote", "research", "survey", "competitor_analysis",
  "contract", "invoice", "prototype_cost", "document"
] as const;
export const LINKED_ENTITY_TYPES = [
  "assumption", "product", "decision", "risk", "company", "funding", "kpi",
  "report", "scenario", "hire", "document"
] as const;

type Db = Pick<PoolClient, "query">;
type Input = Record<string, unknown>;

const error = (message: string, code = "invalid_evidence_payload", statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const requiredText = (value: unknown, field: string) => {
  const parsed = text(value);
  if (!parsed) throw error(`${field} is required`);
  return parsed;
};
const enumValue = <T extends readonly string[]>(value: unknown, field: string, allowed: T, fallback?: T[number]) => {
  if ((value === undefined || value === null || value === "") && fallback) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) throw error(`Invalid ${field}`);
  return value as T[number];
};
const number = (value: unknown, field: string, min: number, max?: number) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) throw error(`Invalid ${field}`);
  return parsed;
};
const date = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw error(`Invalid ${field}`);
  return value;
};
const uuid = (value: unknown, field: string) => {
  const parsed = requiredText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) throw error(`Invalid ${field}`);
  return parsed;
};

export const validateEvidenceInput = (input: Input, partial = false) => {
  const backendManaged = ["folder_path", "r2_object_key", "evidence_code", "file_version", "storage_provider", "original_filename", "mime_type", "file_size", "checksum"]
    .filter(field => field in input);
  if (backendManaged.length) throw error(`Backend-managed fields are not accepted: ${backendManaged.join(", ")}`);
  const output: Record<string, unknown> = {};
  if (!partial || "title" in input) output.title = requiredText(input.title, "title");
  if (!partial || "evidence_type" in input) output.evidence_type = enumValue(input.evidence_type, "evidence_type", EVIDENCE_TYPES);
  if ("description" in input || "summary" in input) output.description = text(input.description ?? input.summary);
  if ("document_category" in input) output.document_category = enumValue(input.document_category, "document_category", DOCUMENT_CATEGORIES);
  if ("source_organisation" in input || "source" in input) output.source_organisation = text(input.source_organisation ?? input.source);
  for (const field of ["owner", "review_frequency"] as const) {
    if (field in input) output[field] = text(input[field]);
  }
  if ("confidence" in input) output.confidence = number(input.confidence, "confidence", 0, 1);
  if (!partial || "verification_status" in input) output.verification_status = enumValue(input.verification_status, "verification_status", VERIFICATION_STATUSES, "Unknown");
  if (!partial || "document_status" in input) output.document_status = enumValue(input.document_status, "document_status", DOCUMENT_STATUSES, "Draft");
  for (const field of ["last_reviewed_date", "next_review_date", "expiry_date", "document_date"] as const) if (field in input) output[field] = date(input[field], field);
  if ("change_reason" in input || !partial) output.change_reason = text(input.change_reason) ?? (partial ? "Updated evidence metadata" : "Created evidence metadata");
  return output;
};

const fields = ["title", "description", "evidence_type", "document_category", "source_organisation", "owner", "confidence", "verification_status", "document_status", "review_frequency", "last_reviewed_date", "next_review_date", "expiry_date", "document_date", "change_reason"];

export const createEvidence = async (input: Input, userId: string, db: Db = pool) => {
  const value = validateEvidenceInput(input);
  const names = fields.filter(field => field in value);
  const params = names.map(name => value[name]);
  const result = await db.query(`INSERT INTO finance_os.evidence (${names.join(", ")}, created_by, updated_by, storage_provider, signed_url_available) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, $${params.length + 1}, $${params.length + 1}, 'r2', false) RETURNING *`, [...params, userId]);
  return result.rows[0];
};

export const getEvidence = async (id: string, db: Db = pool) => {
  const result = await db.query(`SELECT e.*, COALESCE(jsonb_agg(l ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS links FROM finance_os.evidence e LEFT JOIN finance_os.evidence_links l ON l.evidence_id = e.id WHERE e.id = $1 GROUP BY e.id`, [uuid(id, "evidence id")]);
  if (!result.rows[0]) throw error("Evidence not found", "evidence_not_found", 404);
  return result.rows[0];
};

export const listEvidence = async (filters: Input, db: Db = pool) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (text(filters.title)) add("e.title ILIKE '%' || ? || '%'", text(filters.title));
  if (filters.category) add("e.document_category = ?", enumValue(filters.category, "category", DOCUMENT_CATEGORIES));
  if (filters.evidence_type) add("e.evidence_type = ?", enumValue(filters.evidence_type, "evidence_type", EVIDENCE_TYPES));
  if (text(filters.source_organisation)) add("e.source_organisation ILIKE '%' || ? || '%'", text(filters.source_organisation));
  if (text(filters.owner)) add("e.owner ILIKE '%' || ? || '%'", text(filters.owner));
  if (filters.verification_status) add("e.verification_status = ?", enumValue(filters.verification_status, "verification_status", VERIFICATION_STATUSES));
  if (filters.linked_entity_type) add("l.entity_type = ?", enumValue(filters.linked_entity_type, "linked_entity_type", LINKED_ENTITY_TYPES));
  if (filters.linked_entity_id) add("l.entity_id = ?", uuid(filters.linked_entity_id, "linked_entity_id"));
  if (text(filters.keyword)) add("(e.title ILIKE '%' || ? || '%' OR e.description ILIKE '%' || $" + (params.length + 1) + " || '%' OR e.source_organisation ILIKE '%' || $" + (params.length + 1) + " || '%')", text(filters.keyword));
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const result = await db.query(`SELECT DISTINCT e.* FROM finance_os.evidence e LEFT JOIN finance_os.evidence_links l ON l.evidence_id = e.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.created_at DESC LIMIT $${params.length}`, params);
  return result.rows;
};

export const updateEvidence = async (id: string, input: Input, userId: string, db: Db = pool) => {
  const value = validateEvidenceInput(input, true);
  const names = fields.filter(field => field in value && field !== "change_reason");
  if (!names.length) throw error("No evidence metadata fields supplied");
  await db.query(`SELECT id FROM finance_os.evidence WHERE id = $1 FOR UPDATE`, [uuid(id, "evidence id")]);
  const current = await getEvidence(id, db);
  const nextVersion = Number(current.version) + 1;
  await db.query(`INSERT INTO finance_os.evidence_versions (evidence_id, version, snapshot, change_reason, created_by) VALUES ($1, $2, $3, $4, $5)`, [current.id, current.version, JSON.stringify(current), value.change_reason ?? "Updated evidence metadata", userId]);
  const params = names.map(name => value[name]);
  params.push(userId, nextVersion, value.change_reason ?? "Updated evidence metadata", current.id);
  const result = await db.query(`UPDATE finance_os.evidence SET ${names.map((name, i) => `${name} = $${i + 1}`).join(", ")}, updated_by = $${names.length + 1}, version = $${names.length + 2}, change_reason = $${names.length + 3} WHERE id = $${names.length + 4} RETURNING *`, params);
  return result.rows[0];
};

const TARGET_TABLES: Partial<Record<typeof LINKED_ENTITY_TYPES[number], string>> = {
  assumption: "finance_os.assumptions", product: "finance_os.products", decision: "finance_os.decisions",
  risk: "finance_os.risks", funding: "finance_os.funding", report: "finance_os.reports",
  scenario: "finance_os.scenarios", hire: "finance_os.hires", document: "finance_os.documents",
  company: "finance_os.company"
};

export const linkEvidence = async (evidenceId: string, input: Input, userId: string, db: Db = pool) => {
  const entityType = enumValue(input.entity_type, "entity_type", LINKED_ENTITY_TYPES);
  const entityId = uuid(input.entity_id, "entity_id");
  await getEvidence(evidenceId, db);
  const table = TARGET_TABLES[entityType];
  if (!table) throw error(`Entity type ${entityType} is reserved but has no canonical table`, "unsupported_evidence_entity", 422);
  const target = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [entityId]);
  if (!target.rows[0]) throw error("Linked entity not found", "linked_entity_not_found", 404);
  try {
    const result = await db.query(`INSERT INTO finance_os.evidence_links (evidence_id, entity_type, entity_id, relationship, notes, created_by, updated_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING *`, [evidenceId, entityType, entityId, text(input.relationship) ?? "supports", text(input.notes), userId, text(input.change_reason) ?? "Linked evidence"]);
    return result.rows[0];
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505") throw error("Evidence link already exists", "duplicate_evidence_link", 409);
    throw cause;
  }
};

export const unlinkEvidence = async (evidenceId: string, linkId: string, db: Db = pool) => {
  const result = await db.query(`DELETE FROM finance_os.evidence_links WHERE id = $1 AND evidence_id = $2 RETURNING *`, [uuid(linkId, "link id"), uuid(evidenceId, "evidence id")]);
  if (!result.rows[0]) throw error("Evidence link not found", "evidence_link_not_found", 404);
  return result.rows[0];
};

export const getLinkedEvidence = async (entityTypeValue: unknown, entityIdValue: unknown, db: Db = pool) => {
  const entityType = enumValue(entityTypeValue, "entity_type", LINKED_ENTITY_TYPES);
  const entityId = uuid(entityIdValue, "entity_id");
  const result = await db.query(`SELECT e.*, l.id AS link_id, l.relationship, l.notes AS link_notes, l.created_at AS linked_at FROM finance_os.evidence_links l JOIN finance_os.evidence e ON e.id = l.evidence_id WHERE l.entity_type = $1 AND l.entity_id = $2 ORDER BY l.created_at DESC`, [entityType, entityId]);
  return result.rows;
};

export const getEvidenceVersions = async (id: string, db: Db = pool) => {
  const result = await db.query(`SELECT * FROM finance_os.evidence_versions WHERE evidence_id = $1 ORDER BY version DESC`, [uuid(id, "evidence id")]);
  return result.rows;
};
