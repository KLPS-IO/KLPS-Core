/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProcurementProgress,
  deriveProcurementProgress
} from "../rd-lab/procurement-progress.service";

const WP_ID = "33333333-3333-4333-8333-333333333333";
const empty = {
  work_package_status: "Supplier Discovery",
  suppliers_identified: 0, suppliers_verified: 0, suppliers_shortlisted: 0, suppliers_contacted: 0,
  suppliers_discovery_complete: 0, suppliers_selected: 0, interactions_count: 0,
  discovery_meetings_completed: 0, rfqs_total: 0, rfqs_draft_or_ready: 0,
  rfqs_sent: 0, rfqs_response_received: 0, rfqs_terminal: 0,
  quotations_received: 0, valid_quotations: 0, valid_quotation_suppliers: 0,
  recommendations_recorded: 0, selection_decisions_recorded: 0,
  single_source_justifications: 0,
  finance_mappings_total: 0, finance_mappings_ready: 0,
  finance_mappings_complete: 0, accepted_pathways: 0,
  critical_actions_open: 0, linked_evidence_count: 0
};
const progress = (values: Partial<typeof empty> = {}) =>
  deriveProcurementProgress(WP_ID, { ...empty, ...values }, "2026-07-28T08:00:00.000Z");
const stage = (result: ReturnType<typeof progress>, key: string) =>
  result.stages.find(item => item.key === key)!;

test("empty work package starts at Research without a percentage", () => {
  const result = progress();
  assert.equal(result.current_stage, "Research");
  assert.equal(result.next_action, "Establish the first verified supplier record");
  assert.equal(stage(result, "research").state, "Not Started");
  assert.equal(JSON.stringify(result).includes("percentage"), false);
});

test("research progresses and becomes ready when a supplier is verified", () => {
  assert.equal(stage(progress({ suppliers_identified: 2 }), "research").state, "In Progress");
  const verified = progress({ suppliers_identified: 2, suppliers_verified: 1 });
  assert.equal(stage(verified, "research").state, "Ready");
  assert.equal(verified.next_action, "Contact the first verified supplier");
});

test("supplier contact and discovery drive engagement without fabricated targets", () => {
  const contacted = progress({
    suppliers_identified: 1, suppliers_verified: 1, suppliers_shortlisted: 1, suppliers_contacted: 1
  });
  assert.equal(stage(contacted, "research").state, "Complete");
  assert.equal(stage(contacted, "supplier_engagement").state, "In Progress");
  assert.equal(contacted.next_action, "Book the first supplier discovery meeting");
  const discovery = progress({
    suppliers_identified: 1, suppliers_verified: 1, suppliers_shortlisted: 1, suppliers_contacted: 1,
    suppliers_discovery_complete: 1, discovery_meetings_completed: 1
  });
  assert.equal(stage(discovery, "supplier_engagement").state, "Ready");
  assert.equal(discovery.next_action, "Prepare the first RFQ");
});

test("RFQ draft, sent and response states are derived canonically", () => {
  const base = {
    suppliers_identified: 1, suppliers_verified: 1, suppliers_shortlisted: 1, suppliers_contacted: 1,
    suppliers_discovery_complete: 1
  };
  const draft = progress({ ...base, rfqs_total: 1, rfqs_draft_or_ready: 1 });
  assert.equal(stage(draft, "rfqs").state, "In Progress");
  assert.equal(draft.next_action, "Issue the RFQ");
  const sent = progress({ ...base, rfqs_total: 1, rfqs_sent: 1 });
  assert.equal(stage(sent, "rfqs").state, "Ready");
  assert.equal(sent.next_action, "Follow up on the outstanding quotation");
  const responded = progress({
    ...base, rfqs_total: 1, rfqs_sent: 1, rfqs_response_received: 1, rfqs_terminal: 1
  });
  assert.equal(stage(responded, "rfqs").state, "Complete");
});

test("one valid quotation is ready while two suppliers make comparison meaningful", () => {
  const one = progress({
    suppliers_identified: 2, suppliers_verified: 2, suppliers_shortlisted: 2, suppliers_contacted: 1,
    suppliers_discovery_complete: 1, rfqs_total: 1, rfqs_sent: 1,
    rfqs_response_received: 1, quotations_received: 1, valid_quotations: 1,
    valid_quotation_suppliers: 1
  });
  assert.equal(stage(one, "quotations").state, "Ready");
  assert.equal(one.blocking_reason, "Only one valid quotation has been received");
  const two = progress({
    ...empty, ...one.summary, suppliers_discovery_complete: 1, rfqs_total: 2,
    rfqs_response_received: 2, valid_quotations: 2, valid_quotation_suppliers: 2
  });
  assert.equal(stage(two, "quotations").state, "Complete");
  assert.equal(stage(two, "comparison").state, "In Progress");
  assert.equal(two.next_action, "Compare quotations and record a recommendation");
});

test("invalid quotation counts as received but is excluded from valid progress", () => {
  const result = progress({ rfqs_sent: 1, quotations_received: 1, valid_quotations: 0 });
  assert.equal(stage(result, "quotations").state, "In Progress");
  assert.equal(result.summary.quotations_received, 1);
  assert.equal(result.summary.valid_quotations, 0);
});

test("recommendation and selection decision advance comparison", () => {
  const facts = {
    valid_quotations: 2, valid_quotation_suppliers: 2, quotations_received: 2
  };
  const recommended = progress({ ...facts, recommendations_recorded: 1 });
  assert.equal(stage(recommended, "comparison").state, "Ready");
  assert.equal(recommended.next_action, "Record the supplier-selection decision");
  const selected = progress({
    ...facts, recommendations_recorded: 1, selection_decisions_recorded: 1
  });
  assert.equal(stage(selected, "comparison").state, "Complete");
  assert.equal(selected.next_action, "Map the approved cost range into Finance OS");
});

test("one quote requires an approved single-source justification before comparison can complete", () => {
  const unsupported = progress({
    valid_quotations: 1, valid_quotation_suppliers: 1,
    recommendations_recorded: 1, selection_decisions_recorded: 1
  });
  assert.notEqual(stage(unsupported, "comparison").state, "Complete");
  const justified = progress({
    valid_quotations: 1, valid_quotation_suppliers: 1,
    recommendations_recorded: 1, selection_decisions_recorded: 1,
    single_source_justifications: 1
  });
  assert.equal(stage(justified, "quotations").state, "Complete");
  assert.equal(stage(justified, "comparison").state, "Complete");
});

test("Finance OS mapping distinguishes ready from terminal", () => {
  const ready = progress({
    selection_decisions_recorded: 1, finance_mappings_total: 1, finance_mappings_ready: 1
  });
  assert.equal(stage(ready, "finance_os_mapping").state, "Ready");
  const mapped = progress({
    selection_decisions_recorded: 1, finance_mappings_total: 1,
    finance_mappings_complete: 1
  });
  assert.equal(stage(mapped, "finance_os_mapping").state, "Complete");
});

test("critical actions block final completion", () => {
  const result = progress({
    work_package_status: "Validated", suppliers_identified: 2, suppliers_verified: 2,
    suppliers_shortlisted: 2, suppliers_contacted: 1, suppliers_discovery_complete: 1,
    rfqs_total: 2, rfqs_sent: 2, rfqs_response_received: 2, rfqs_terminal: 2,
    quotations_received: 2, valid_quotations: 2, valid_quotation_suppliers: 2,
    recommendations_recorded: 1, selection_decisions_recorded: 1,
    finance_mappings_total: 1, finance_mappings_complete: 1,
    accepted_pathways: 1, linked_evidence_count: 1, critical_actions_open: 1
  });
  assert.equal(result.current_stage, "Complete");
  assert.equal(result.blocking_reason, "Critical action remains open");
  assert.equal(stage(result, "complete").state, "Not Started");
});

test("validated work package completes only with pathway, decision, mapping and evidence", () => {
  const result = progress({
    work_package_status: "Validated", suppliers_identified: 2, suppliers_verified: 2,
    suppliers_shortlisted: 2, suppliers_contacted: 1, suppliers_discovery_complete: 1,
    rfqs_total: 2, rfqs_sent: 2, rfqs_response_received: 2, rfqs_terminal: 2,
    quotations_received: 2, valid_quotations: 2, valid_quotation_suppliers: 2,
    recommendations_recorded: 1, selection_decisions_recorded: 1,
    finance_mappings_total: 1, finance_mappings_complete: 1,
    accepted_pathways: 1, linked_evidence_count: 1
  });
  assert.equal(result.current_stage, "Complete");
  assert.equal(stage(result, "complete").state, "Complete");
  assert.equal(result.next_action, "WP1 procurement complete");
});

test("progress lookup rejects invalid and missing work-package ids", async () => {
  await assert.rejects(calculateProcurementProgress("bad", { query: async () => ({ rows: [] }) } as never),
    (reason: unknown) => (reason as { code?: string }).code === "invalid_work_package_id");
  await assert.rejects(calculateProcurementProgress(WP_ID, { query: async () => ({ rows: [] }) } as never),
    (reason: unknown) => (reason as { code?: string }).code === "work_package_not_found");
});
