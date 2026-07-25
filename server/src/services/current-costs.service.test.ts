/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  completedPrototypePurchases,
  knownAmountOrNull,
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
  assert.equal(knownAmountOrNull(null), null);
  assert.equal(knownAmountOrNull(undefined), null);
  assert.equal(knownAmountOrNull(""), null);
  assert.equal(knownAmountOrNull("not confirmed"), null);
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
