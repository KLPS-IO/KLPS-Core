export const financialTreatments = [
  "Operating Expense",
  "R&D Materials",
  "R&D Services",
  "Professional Services",
  "Business Development",
  "Marketing",
  "Premises",
  "Capital Expenditure",
  "Cost of Goods Sold",
  "Tax and Statutory",
  "Other",
  "To Classify"
] as const;

export type FinancialTreatment = typeof financialTreatments[number];

export type ExpenseCalculationRow = {
  cost_type?: unknown;
  frequency?: unknown;
  evidence_status?: unknown;
  paid_by?: unknown;
  payment_channel?: unknown;
  company_cash_outflow?: unknown;
  gross_amount?: unknown;
  net_amount?: unknown;
  vat_amount?: unknown;
  recurring_run_rate_net?: unknown;
  klps_allocation_amount?: unknown;
  klps_allocation_percentage?: unknown;
  financial_treatment?: unknown;
};

export type MoneyMetric = {
  amount: number | null;
  known_count: number;
  excluded_unknown_count: number;
};

export type ExpenseMetrics = {
  verified_actual_spend: MoneyMetric;
  founder_funded_business_spend: MoneyMetric;
  company_bank_cash_spend: MoneyMetric;
  recurring_monthly_run_rate_net: MoneyMetric;
  actual_net: MoneyMetric;
  actual_vat: MoneyMetric;
  actual_gross: MoneyMetric;
  category_totals: Array<{ financial_treatment: string; amount: number; known_count: number }>;
  awaiting_evidence_count: number;
  shared_allocation_pending_count: number;
};

export type CurrentCost = {
  importKey: string;
  name: string;
  supplier: string | null;
  costType: string;
  frequency: string | null;
  netAmount: number | null;
  vatAmount: number | null;
  grossAmount: number | null;
  companyCashOutflow: boolean;
  klpsAllocationAmount: number | null;
  evidenceId: string | null;
};

export function toFiniteMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sumKnownMoney(values: unknown[]): number {
  return Math.round(values.reduce<number>((total, value) => {
    const money = toFiniteMoney(value);
    return money === null ? total : total + money;
  }, 0) * 100) / 100;
}

function moneyMetric(values: unknown[]): MoneyMetric {
  const known = values.map(toFiniteMoney).filter((value): value is number => value !== null);
  return {
    amount: known.length ? sumKnownMoney(known) : null,
    known_count: known.length,
    excluded_unknown_count: values.length - known.length
  };
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const isPlanned = (row: ExpenseCalculationRow) =>
  text(row.cost_type).includes("planned") || text(row.cost_type).includes("future");
const isActual = (row: ExpenseCalculationRow) =>
  !isPlanned(row) && (
    text(row.cost_type) === "actual transaction" ||
    text(row.cost_type) === "one-off programme cost" ||
    text(row.cost_type) === "recurring operating cost"
  );
const isFounderFunded = (row: ExpenseCalculationRow) =>
  text(row.paid_by) === "founder" || text(row.payment_channel).includes("founder") || text(row.payment_channel).includes("personal");
const businessAmount = (row: ExpenseCalculationRow) => {
  const allocated = toFiniteMoney(row.klps_allocation_amount);
  const allocation = toFiniteMoney(row.klps_allocation_percentage);
  if (allocation !== null && allocation <= 0) return null;
  return allocated;
};

export function calculateExpenseMetrics(rows: ExpenseCalculationRow[]): ExpenseMetrics {
  const actual = rows.filter(isActual);
  const verified = actual.filter(row => text(row.evidence_status) === "verified");
  const founderFunded = actual.filter(row => isFounderFunded(row) && businessAmount(row) !== null);
  const companyCash = actual.filter(row => row.company_cash_outflow === true);
  const monthly = rows.filter(row => !isPlanned(row) && text(row.frequency) === "monthly");

  const categories = new Map<string, { values: unknown[]; known_count: number }>();
  for (const row of actual) {
    const amount = businessAmount(row);
    if (amount === null) continue;
    const treatment = financialTreatments.includes(row.financial_treatment as FinancialTreatment)
      ? String(row.financial_treatment)
      : "To Classify";
    const current = categories.get(treatment) ?? { values: [], known_count: 0 };
    current.values.push(amount);
    current.known_count += 1;
    categories.set(treatment, current);
  }

  return {
    verified_actual_spend: moneyMetric(verified.map(businessAmount)),
    founder_funded_business_spend: moneyMetric(founderFunded.map(businessAmount)),
    company_bank_cash_spend: moneyMetric(companyCash.map(businessAmount)),
    recurring_monthly_run_rate_net: moneyMetric(monthly.map(row => row.recurring_run_rate_net)),
    actual_net: moneyMetric(actual.map(row => row.net_amount)),
    actual_vat: moneyMetric(actual.map(row => row.vat_amount)),
    actual_gross: moneyMetric(actual.map(row => row.gross_amount)),
    category_totals: [...categories.entries()].map(([financial_treatment, value]) => ({
      financial_treatment,
      amount: sumKnownMoney(value.values),
      known_count: value.known_count
    })),
    awaiting_evidence_count: rows.filter(row => text(row.evidence_status) !== "verified").length,
    shared_allocation_pending_count: rows.filter(row =>
      text(row.cost_type) === "recurring shared cost" &&
      toFiniteMoney(row.klps_allocation_amount) === null
    ).length
  };
}

export const completedPrototypePurchases: CurrentCost[] = [
  ["paypal-ebay-2025-10-20-749", "Prototype purchase", "eBay Commerce UK Ltd", 7.49],
  ["paypal-ebay-2025-10-05-997", "Prototype purchase", "eBay Commerce UK Ltd", 9.97],
  ["paypal-ebay-2025-10-05-265", "Prototype purchase", "eBay Commerce UK Ltd", 2.65],
  ["paypal-ebay-2025-10-05-320", "Prototype purchase", "eBay Commerce UK Ltd", 3.20],
  ["paypal-ebay-2025-10-05-555", "Prototype purchase", "eBay Commerce UK Ltd", 5.55],
  ["paypal-ebay-2025-10-05-190", "Prototype purchase", "eBay Commerce UK Ltd", 1.90],
  ["paypal-ebay-2025-10-05-1788", "Prototype purchase", "eBay Commerce UK Ltd", 17.88],
  ["paypal-mann-2025-10-05-2270", "Prototype purchase", "Mann Enterprises Ltd", 22.70],
  ["paypal-kitronik-2025-10-05-3174", "Prototype purchase", "Kitronik", 31.74]
].map(([importKey, name, supplier, grossAmount]) => ({
  importKey: String(importKey),
  name: String(name),
  supplier: String(supplier),
  costType: "actual transaction",
  frequency: "One-off",
  netAmount: null,
  vatAmount: null,
  grossAmount: toFiniteMoney(grossAmount),
  companyCashOutflow: false,
  klpsAllocationAmount: toFiniteMoney(grossAmount),
  evidenceId: null
}));

export const sumKnownGross = (costs: CurrentCost[]) =>
  sumKnownMoney(costs.map(cost => cost.grossAmount));

export const knownAmountOrNull = toFiniteMoney;
