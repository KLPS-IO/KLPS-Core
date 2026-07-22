import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { getLinkedEvidence } from "./evidence.service";

type Db = Pick<PoolClient, "query">;
type Input = Record<string, unknown>;

const error = (message: string, code = "invalid_company_payload", statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const requiredText = (value: unknown, field: string) => {
  const parsed = text(value);
  if (!parsed) throw error(`${field} is required`);
  return parsed;
};

const enums: Record<string, readonly string[]> = {
  company_status: ["Active", "Dormant", "Closed", "Dissolved"],
  accounting_method: ["Unknown", "Cash", "Accrual"],
  corporation_tax_status: ["Unknown", "Registered", "Active", "Dormant", "Closed"],
  ico_status: ["Not Started", "Preparing", "Applied", "Registered", "Exempt", "Cancelled"],
  seis_status: ["Not Started", "Preparing", "Submitted", "Approved", "Rejected"],
  seis_advance_assurance_status: ["Not Submitted", "Preparing", "Submitted", "Under Review", "Approved", "Rejected"],
  business_bank_status: ["Not Opened", "Application Pending", "Under Review", "Open", "Rejected", "Closed"],
  vat_status: ["Not Started", "Applied", "Approved", "Rejected", "Cancelled"]
};
const requiredFields = ["legal_name", "trading_name", "company_number", "company_type", "company_status", "incorporation_date", "base_currency"];
const textFields = [
  "legal_name", "trading_name", "company_number", "company_type", "registered_office_line_1",
  "registered_office_line_2", "registered_office_line_3", "registered_office_city",
  "registered_office_county", "registered_office_postcode", "registered_office_country",
  "base_currency", "company_status", "accounting_method", "corporation_tax_status", "vat_status",
  "vat_registration_number", "vat_scheme", "ico_status", "ico_registration_number",
  "seis_status", "seis_advance_assurance_status", "seis_target_submission_period",
  "seis_reference_number", "business_bank_name", "business_bank_status", "founder_name"
];
const dateFields = [
  "incorporation_date", "first_accounts_period_end", "first_accounts_filing_deadline",
  "vat_effective_date", "vat_accounting_period_start", "vat_accounting_period_end",
  "seis_decision_date", "business_bank_opened_date"
];
export const COMPANY_UPDATE_FIELDS = [...textFields, ...dateFields, "financial_year_end_month", "financial_year_end_day", "sic_codes", "trl", "crl", "metadata"];

const validDate = (value: unknown, field: string) => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw error(`Invalid ${field}`);
  return value;
};
const integer = (value: unknown, field: string, min: number, max: number) => {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw error(`Invalid ${field}`);
  return value;
};

export const validateCompanyUpdate = (input: Input) => {
  const changeReason = requiredText(input.change_reason, "change_reason");
  const output: Input = { change_reason: changeReason };
  for (const field of COMPANY_UPDATE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (requiredFields.includes(field) && (value === null || value === undefined || value === "")) throw error(`${field} is required`);
    if (textFields.includes(field)) {
      const parsed = text(value);
      if (value !== null && !parsed) throw error(`Invalid ${field}`);
      if (enums[field] && parsed && !enums[field].includes(parsed)) throw error(`Invalid ${field}`);
      output[field] = parsed;
    } else if (dateFields.includes(field)) output[field] = validDate(value, field);
    else if (field === "financial_year_end_month") output[field] = integer(value, field, 1, 12);
    else if (field === "financial_year_end_day") output[field] = integer(value, field, 1, 31);
    else if (field === "trl" || field === "crl") output[field] = integer(value, field, 1, 9);
    else if (field === "sic_codes") {
      if (!Array.isArray(value) || !value.every(code => typeof code === "string" && code.trim())) throw error("Invalid sic_codes");
      output[field] = value;
    } else if (field === "metadata") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw error("Invalid metadata");
      output[field] = value;
    }
  }
  if (Object.keys(output).length === 1) throw error("At least one company field is required", "no_company_updates");
  return output;
};

export const getCompany = async (db: Db = pool) => {
  const result = await db.query("SELECT * FROM finance_os.company ORDER BY created_at ASC LIMIT 1");
  if (!result.rows[0]) throw error("Company not found", "company_not_found", 404);
  return result.rows[0];
};

export const updateCompany = async (input: Input, userId: string, db: Db = pool) => {
  const value = validateCompanyUpdate(input);
  const locked = await db.query("SELECT * FROM finance_os.company ORDER BY created_at ASC LIMIT 1 FOR UPDATE");
  const current = locked.rows[0];
  if (!current) throw error("Company not found", "company_not_found", 404);
  await db.query("INSERT INTO finance_os.company_versions (company_id, version, snapshot, change_reason, created_by) VALUES ($1, $2, $3, $4, $5)", [current.id, current.version, JSON.stringify(current), value.change_reason, userId]);
  const names = COMPANY_UPDATE_FIELDS.filter(field => field in value);
  const params = names.map(name => name === "sic_codes" || name === "metadata" ? JSON.stringify(value[name]) : value[name]);
  params.push(userId, Number(current.version) + 1, value.change_reason, current.id);
  const result = await db.query(`UPDATE finance_os.company SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, updated_by = $${names.length + 1}, version = $${names.length + 2}, change_reason = $${names.length + 3} WHERE id = $${names.length + 4} RETURNING *`, params);
  return result.rows[0];
};

export const getCompanyVersions = async (db: Db = pool) => {
  const company = await getCompany(db);
  const result = await db.query("SELECT * FROM finance_os.company_versions WHERE company_id = $1 ORDER BY version DESC", [company.id]);
  return result.rows;
};

export const getCompanyEvidence = async (db: Db = pool) => {
  const company = await getCompany(db);
  return getLinkedEvidence("company", company.id, db);
};

export const getCompanyHealth = async (db: Db = pool) => {
  const company = await getCompany(db);
  const evidence = await getLinkedEvidence("company", company.id, db);
  const warnings: Array<{ code: string; severity: "warning"; field: string; message: string }> = [];
  const add = (condition: boolean, code: string, field: string, message: string) => {
    if (condition) warnings.push({ code, severity: "warning", field, message });
  };
  add(!company.corporation_tax_status || company.corporation_tax_status === "Unknown", "CORPORATION_TAX_UNKNOWN", "corporation_tax_status", "Corporation Tax status is unknown");
  add(!company.accounting_method || company.accounting_method === "Unknown", "ACCOUNTING_METHOD_UNKNOWN", "accounting_method", "Accounting method is unknown");
  add(!["Registered", "Exempt"].includes(company.ico_status), "ICO_NOT_REGISTERED", "ico_status", "ICO registration is not complete");
  add(!["Submitted", "Approved"].includes(company.seis_status), "SEIS_NOT_SUBMITTED", "seis_status", "SEIS has not been submitted");
  add(company.business_bank_status !== "Open", "BANK_NOT_OPEN", "business_bank_status", "Business bank account is not open");
  add(company.crl == null, "CRL_NOT_CONFIRMED", "crl", "CRL is not confirmed");
  add(evidence.length === 0, "NO_COMPANY_EVIDENCE", "evidence", "No evidence is linked to the company");
  const fieldCount = 7;
  const unknownFieldCount = warnings.length;
  return {
    completion_percentage: Math.round(((fieldCount - unknownFieldCount) / fieldCount) * 100),
    verified_field_count: fieldCount - unknownFieldCount,
    unknown_field_count: unknownFieldCount,
    warnings
  };
};
