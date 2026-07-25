/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  calculateExpenseMetrics,
  completedPrototypePurchases,
  financialTreatments,
  knownAmountOrNull,
  sumKnownMoney,
  sumKnownGross
} from "./current-costs.service";

const migration = readFileSync(
  join(process.cwd(), "server/sql/20260725_current_costs_batch_001.sql"),
  "utf8"
);

test("completed PayPal supplier purchases total GBP 103.08 without withdrawal rows", () => {
  assert.equal(completedPrototypePurchases.length, 9);
  assert.equal(sumKnownGross(completedPrototypePurchases), 103.08);
  assert.equal(completedPrototypePurchases.some(cost => /withdraw|authorisation/i.test(cost.name)), false);
});

test("unknown amounts remain null rather than becoming zero", () => {
  assert.equal(knownAmountOrNull(12.34), 12.34);
  assert.equal(knownAmountOrNull("12.34"), 12.34);
  assert.equal(knownAmountOrNull(null), null);
  assert.equal(knownAmountOrNull(undefined), null);
  assert.equal(knownAmountOrNull(""), null);
  assert.equal(knownAmountOrNull("not confirmed"), null);
  assert.equal(knownAmountOrNull(Number.NaN), null);
  assert.equal(knownAmountOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(knownAmountOrNull("Infinity"), null);
});

test("known money aggregation ignores unknown and non-finite values", () => {
  assert.equal(sumKnownMoney([12.34, "7.66", null, undefined, "", "Not confirmed", Number.NaN, Number.POSITIVE_INFINITY]), 20);
});

test("founder-funded prototype purchases are economic costs but not company cash outflow", () => {
  for (const cost of completedPrototypePurchases) {
    assert.equal(cost.companyCashOutflow, false);
    assert.equal(cost.klpsAllocationAmount, cost.grossAmount);
    assert.equal(cost.evidenceId, null);
  }
});

test("migration contains verified ChatGPT invoice amounts and separate recurring run-rate", () => {
  assert.match(migration, /'current-chatgpt-plus-2026'[\s\S]*?'OpenAI OpCo, LLC'/);
  assert.match(migration, /'2026-07-20',[\s\S]*?15\.56, -1\.11, 3\.11, 0\.20, 18\.67/);
  assert.match(migration, /16\.67, 0\.20, 18\.67, 1\.00/);
  assert.match(migration, /'Verified', 'OpenAI invoice TZVOPHMG-0009'/);
  assert.match(migration, /Updated from placeholder pricing to verified OpenAI invoice values/);
});

test("migration preserves unknown shared and planned values as null", () => {
  assert.match(migration, /'shared-sovereign-studios-workspace-2026'[\s\S]*?100\.00, 'per week', NULL,\s+NULL, NULL, NULL/);
  assert.match(migration, /'planned-blooming-books-accountancy-2026'[\s\S]*?NULL, NULL, NULL, NULL, NULL/);
  assert.match(migration, /'planned-business-insurance-2026'[\s\S]*?"forecast_cost":"Unknown"/);
});

test("batch is idempotent and creates no fake evidence records or links", () => {
  assert.match(migration, /import_key text NOT NULL UNIQUE/);
  assert.match(migration, /ON CONFLICT \(import_key\) DO UPDATE SET/);
  assert.doesNotMatch(migration, /INSERT INTO finance_os\.evidence\s*\(/);
  assert.doesNotMatch(migration, /INSERT INTO finance_os\.evidence_links\s*\(/);
});

test("expense metrics exclude planned unknown costs without producing NaN", () => {
  const metrics = calculateExpenseMetrics([
    {
      cost_type: "Recurring operating cost",
      frequency: "Monthly",
      evidence_status: "Verified",
      paid_by: "founder",
      payment_channel: "personal funds",
      gross_amount: "18.67",
      net_amount: "15.56",
      vat_amount: "3.11",
      recurring_run_rate_net: "16.67",
      klps_allocation_amount: "18.67",
      klps_allocation_percentage: "1.00",
      company_cash_outflow: false,
      financial_treatment: "Operating Expense"
    },
    {
      cost_type: "Planned or unconfirmed professional-service cost",
      evidence_status: "To Evidence",
      gross_amount: null,
      klps_allocation_amount: null,
      paid_by: null,
      company_cash_outflow: null,
      financial_treatment: "Professional Services"
    }
  ]);

  assert.equal(metrics.verified_actual_spend.amount, 18.67);
  assert.equal(metrics.founder_funded_business_spend.amount, 18.67);
  assert.equal(metrics.company_bank_cash_spend.amount, null);
  assert.equal(metrics.recurring_monthly_run_rate_net.amount, 16.67);
  assert.equal(metrics.actual_net.amount, 15.56);
  assert.equal(metrics.actual_vat.amount, 3.11);
  assert.equal(metrics.awaiting_evidence_count, 1);
  assert.deepEqual(metrics.category_totals, [
    { financial_treatment: "Operating Expense", amount: 18.67, known_count: 1 }
  ]);
});

test("founder-funded totals require actual known positive business allocation", () => {
  const metrics = calculateExpenseMetrics([
    { cost_type: "Actual transaction", paid_by: "founder", klps_allocation_amount: "10", klps_allocation_percentage: "1", evidence_status: "Under Review" },
    { cost_type: "Actual transaction", payment_channel: "personal funds", klps_allocation_amount: null, evidence_status: "Under Review" },
    { cost_type: "Actual transaction", paid_by: "founder", klps_allocation_amount: "20", klps_allocation_percentage: "0", evidence_status: "Verified" },
    { cost_type: "Future operating cost", paid_by: "founder", klps_allocation_amount: "30", klps_allocation_percentage: "1", evidence_status: "To Research" }
  ]);
  assert.equal(metrics.founder_funded_business_spend.amount, 10);
  assert.equal(metrics.founder_funded_business_spend.known_count, 1);
});

test("financial treatment values include controlled fallback", () => {
  assert.ok(financialTreatments.includes("To Classify"));
  const treatmentMigration = readFileSync(
    join(process.cwd(), "server/sql/20260725_expense_financial_treatment.sql"),
    "utf8"
  );
  assert.match(treatmentMigration, /financial_treatment text NOT NULL DEFAULT 'To Classify'/);
  assert.match(treatmentMigration, /item-level receipt evidence is reviewed/);
});
