import crypto from "crypto";
import path from "path";
import { PoolClient } from "pg";
import { DOCUMENT_CATEGORIES, LINKED_ENTITY_TYPES, linkEvidence } from "./evidence.service";

type Input = Record<string, unknown>;
type Db = Pick<PoolClient, "query">;

export const DOCUMENT_FOLDERS: Record<typeof DOCUMENT_CATEGORIES[number], string> = {
  "Read First": "00_READ_FIRST",
  Corporate: "01_CORPORATE",
  Finance: "02_FINANCE",
  Fundraising: "03_FUNDRAISING",
  Product: "04_PRODUCT",
  Technology: "05_TECHNOLOGY",
  "Intellectual Property": "06_INTELLECTUAL_PROPERTY",
  Manufacturing: "07_MANUFACTURING",
  Market: "08_MARKET",
  Customers: "09_CUSTOMERS",
  Research: "10_RESEARCH",
  Regulatory: "11_REGULATORY",
  Legal: "12_LEGAL",
  Team: "13_TEAM",
  Press: "14_PRESS",
  Archive: "99_ARCHIVE"
};

const badRequest = (message: string, code = "invalid_document_upload") =>
  Object.assign(new Error(message), { statusCode: 400, code });

const required = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required`);
  return value.trim();
};

const optional = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

const validDate = (value: unknown) => {
  if (value === undefined || value === null || value === "") return new Date().toISOString().slice(0, 10);
  const parsed = required(value, "document_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) {
    throw badRequest("Invalid document_date");
  }
  return parsed;
};

export const parseDocumentUploadInput = (input: Input) => {
  const forbidden = ["folder_path", "r2_object_key", "evidence_code", "file_version", "storage_provider"]
    .filter(field => field in input);
  if (forbidden.length) throw badRequest(`Backend-managed fields are not accepted: ${forbidden.join(", ")}`);

  const title = required(input.title, "title");
  const documentCategory = required(input.document_category, "document_category") as typeof DOCUMENT_CATEGORIES[number];
  if (!DOCUMENT_CATEGORIES.includes(documentCategory)) throw badRequest("Invalid document_category");

  const linkFields = ["linked_entity_type", "linked_entity_id", "relationship"] as const;
  const supplied = linkFields.filter(field => field in input).length;
  if (supplied !== 0 && supplied !== 3) {
    throw badRequest("linked_entity_type, linked_entity_id, and relationship must all be supplied together or all omitted", "partial_entity_link");
  }
  const linkedEntityType = supplied === 3 ? required(input.linked_entity_type, "linked_entity_type") : null;
  if (linkedEntityType && !LINKED_ENTITY_TYPES.includes(linkedEntityType as typeof LINKED_ENTITY_TYPES[number])) {
    throw badRequest("Invalid linked_entity_type");
  }

  return {
    title,
    documentCategory,
    documentDate: validDate(input.document_date),
    description: optional(input.description),
    sourceOrganisation: optional(input.source_organisation),
    linkedEntityType,
    linkedEntityId: supplied === 3 ? required(input.linked_entity_id, "linked_entity_id") : null,
    relationship: supplied === 3 ? required(input.relationship, "relationship") : null
  };
};

const sanitiseTitle = (title: string) => title
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^A-Za-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 120) || "Document";

const extensionFor = (filename: string) => {
  const extension = path.extname(filename).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!extension) throw badRequest("The uploaded file must have an extension", "file_extension_required");
  return extension.slice(0, 12);
};

export const buildDocumentStorage = (category: typeof DOCUMENT_CATEGORIES[number], evidenceCode: string, title: string, documentDate: string, originalFilename: string) => {
  const filename = `${evidenceCode}_${sanitiseTitle(title)}_${documentDate}_v1.${extensionFor(originalFilename)}`;
  const folder = DOCUMENT_FOLDERS[category];
  return { folder, filename, objectKey: `${folder}/${filename}` };
};

export const createUploadedEvidenceRecord = async (input: ReturnType<typeof parseDocumentUploadInput>, file: Express.Multer.File, userId: string, db: Db) => {
  const inserted = await db.query(
    `INSERT INTO finance_os.evidence (title, description, evidence_type, document_category, source_organisation, document_date, original_filename, mime_type, file_size, checksum, created_by, updated_by, storage_provider, signed_url_available, verification_status, document_status, file_version) VALUES ($1, $2, 'document', $3, $4, $5, $6, $7, $8, $9, $10, $10, 'r2', true, 'Unknown', 'Active', 1) RETURNING *`,
    [input.title, input.description, input.documentCategory, input.sourceOrganisation, input.documentDate, file.originalname, file.mimetype || "application/octet-stream", file.size, crypto.createHash("sha256").update(file.buffer).digest("hex"), userId]
  );
  return inserted.rows[0];
};

export const finishUploadedEvidenceRecord = async (evidenceId: string, objectKey: string, db: Db) => {
  const result = await db.query(`UPDATE finance_os.evidence SET r2_object_key = $1 WHERE id = $2 RETURNING *`, [objectKey, evidenceId]);
  return result.rows[0];
};

export const createOptionalUploadLink = async (evidenceId: string, input: ReturnType<typeof parseDocumentUploadInput>, userId: string, db: Db) => {
  if (!input.linkedEntityType) return null;
  return linkEvidence(evidenceId, {
    entity_type: input.linkedEntityType,
    entity_id: input.linkedEntityId,
    relationship: input.relationship,
    change_reason: "Linked during document upload"
  }, userId, db);
};
