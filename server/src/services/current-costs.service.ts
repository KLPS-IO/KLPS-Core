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
  grossAmount: Number(grossAmount),
  companyCashOutflow: false,
  klpsAllocationAmount: Number(grossAmount),
  evidenceId: null
}));

export const sumKnownGross = (costs: CurrentCost[]) =>
  Math.round(costs.reduce(
    (total, cost) => total + (cost.grossAmount ?? 0),
    0
  ) * 100) / 100;

export const knownAmountOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
