import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db = Pick<PoolClient, "query">;
export type ProcurementStageState = "Not Started" | "In Progress" | "Ready" | "Complete";
type ProgressFacts = {
  work_package_status: string;
  suppliers_identified: number;
  suppliers_verified: number;
  suppliers_shortlisted: number;
  suppliers_contacted: number;
  suppliers_discovery_complete: number;
  suppliers_selected: number;
  interactions_count: number;
  discovery_meetings_completed: number;
  rfqs_total: number;
  rfqs_draft_or_ready: number;
  rfqs_sent: number;
  rfqs_response_received: number;
  rfqs_terminal: number;
  quotations_received: number;
  valid_quotations: number;
  valid_quotation_suppliers: number;
  recommendations_recorded: number;
  selection_decisions_recorded: number;
  single_source_justifications: number;
  finance_mappings_total: number;
  finance_mappings_ready: number;
  finance_mappings_complete: number;
  accepted_pathways: number;
  critical_actions_open: number;
  linked_evidence_count: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const progressError = (message: string, code: string, statusCode: number) =>
  Object.assign(new Error(message), { code, statusCode });
const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function deriveProcurementProgress(
  workPackageId: string,
  raw: ProgressFacts,
  calculatedAt = new Date().toISOString()
) {
  const f = Object.fromEntries(Object.entries(raw).map(([key, value]) =>
    key === "work_package_status" ? [key, String(value)] : [key, count(value)]
  )) as unknown as ProgressFacts;
  const engagementStarted = f.suppliers_contacted > 0 || f.interactions_count > 0;
  const rfqStarted = f.rfqs_total > 0;
  const allRfqsTerminal = f.rfqs_total > 0 && f.rfqs_terminal === f.rfqs_total;
  const enoughQuotes = f.valid_quotation_suppliers >= 2;
  const comparisonBasis = enoughQuotes ||
    (f.valid_quotation_suppliers === 1 && f.single_source_justifications > 0);
  const mappingTerminal = f.finance_mappings_total > 0 &&
    f.finance_mappings_complete === f.finance_mappings_total;
  const mappingReady = f.finance_mappings_total > 0 &&
    f.finance_mappings_ready === f.finance_mappings_total;
  const selectionRecorded = f.selection_decisions_recorded > 0 || f.suppliers_selected > 0;

  const research: ProcurementStageState = f.suppliers_identified === 0 ? "Not Started"
    : f.suppliers_verified === 0 ? "In Progress"
    : engagementStarted ? "Complete" : "Ready";
  const engagement: ProcurementStageState = !engagementStarted ? "Not Started"
    : f.suppliers_discovery_complete > 0 && rfqStarted ? "Complete"
    : f.suppliers_discovery_complete > 0 ? "Ready" : "In Progress";
  const rfqs: ProcurementStageState = f.rfqs_total === 0 ? "Not Started"
    : f.rfqs_response_received > 0 || allRfqsTerminal ? "Complete"
    : f.rfqs_sent > 0 ? "Ready" : "In Progress";
  const quotations: ProcurementStageState = comparisonBasis ? "Complete"
    : f.valid_quotations > 0 ? "Ready"
    : f.rfqs_sent > 0 || f.quotations_received > 0 ? "In Progress" : "Not Started";
  const comparison: ProcurementStageState = selectionRecorded && comparisonBasis ? "Complete"
    : f.recommendations_recorded > 0 ? "Ready"
    : enoughQuotes ? "In Progress" : "Not Started";
  const financeMapping: ProcurementStageState = f.finance_mappings_total === 0 ? "Not Started"
    : mappingTerminal ? "Complete"
    : mappingReady ? "Ready" : "In Progress";
  const completeConditions = f.accepted_pathways > 0 && selectionRecorded && comparisonBasis && mappingTerminal &&
    f.linked_evidence_count > 0 && f.critical_actions_open === 0 &&
    ["Validated", "Closed"].includes(f.work_package_status);
  const complete: ProcurementStageState = completeConditions ? "Complete" : "Not Started";

  const stages = [
    { key: "research", label: "Research", state: research, completed_count: f.suppliers_verified, target_count: null,
      supporting_counts: { suppliers_identified: f.suppliers_identified, suppliers_verified: f.suppliers_verified } },
    { key: "supplier_engagement", label: "Supplier Engagement", state: engagement, completed_count: f.suppliers_discovery_complete, target_count: null,
      supporting_counts: { suppliers_contacted: f.suppliers_contacted, discovery_meetings_completed: f.discovery_meetings_completed } },
    { key: "rfqs", label: "RFQs", state: rfqs, completed_count: f.rfqs_sent, target_count: null,
      supporting_counts: { rfqs_created: f.rfqs_total, rfqs_sent: f.rfqs_sent, responses_received: f.rfqs_response_received } },
    { key: "quotations", label: "Quotations", state: quotations, completed_count: f.valid_quotations, target_count: 2,
      supporting_counts: { quotations_received: f.quotations_received, valid_quotations: f.valid_quotations } },
    { key: "comparison", label: "Comparison", state: comparison, completed_count: f.recommendations_recorded, target_count: null,
      supporting_counts: { valid_quotations: f.valid_quotations, recommendations_recorded: f.recommendations_recorded, selection_decisions_recorded: f.selection_decisions_recorded } },
    { key: "finance_os_mapping", label: "Finance OS Mapping", state: financeMapping, completed_count: f.finance_mappings_complete, target_count: f.finance_mappings_total || null,
      supporting_counts: { mappings_total: f.finance_mappings_total, mappings_ready: f.finance_mappings_ready, mappings_complete: f.finance_mappings_complete } },
    { key: "complete", label: "Complete", state: complete, completed_count: completeConditions ? 1 : 0, target_count: 1,
      supporting_counts: { accepted_pathways: f.accepted_pathways, critical_actions_open: f.critical_actions_open, linked_evidence_count: f.linked_evidence_count } }
  ];
  const firstIncomplete = stages.find(stage => stage.state !== "Complete");
  const currentStage = firstIncomplete?.label ?? "Complete";

  let nextAction = "Establish the first verified supplier record";
  if (f.suppliers_identified > 0 && f.suppliers_verified === 0) nextAction = "Verify the first supplier profile";
  else if (f.suppliers_verified > 0 && !engagementStarted) nextAction = "Contact the first verified supplier";
  else if (engagementStarted && f.suppliers_discovery_complete === 0) nextAction = "Book the first supplier discovery meeting";
  else if (f.suppliers_discovery_complete > 0 && f.rfqs_total === 0) nextAction = "Prepare the first RFQ";
  else if (f.rfqs_draft_or_ready > 0 && f.rfqs_sent === 0) nextAction = "Issue the RFQ";
  else if (f.rfqs_sent > 0 && f.valid_quotations === 0) nextAction = "Follow up on the outstanding quotation";
  else if (f.valid_quotation_suppliers === 1 && !selectionRecorded) nextAction = "Obtain a second comparable quotation or record a single-source justification";
  else if (comparisonBasis && f.recommendations_recorded === 0) nextAction = "Compare quotations and record a recommendation";
  else if (f.recommendations_recorded > 0 && !selectionRecorded) nextAction = "Record the supplier-selection decision";
  else if (selectionRecorded && f.finance_mappings_total === 0) nextAction = "Map the approved cost range into Finance OS";
  else if (mappingTerminal && f.critical_actions_open > 0) nextAction = "Resolve the remaining critical actions";
  else if (completeConditions) nextAction = "WP1 procurement complete";

  let blockingReason: string | null = null;
  if (currentStage === "Supplier Engagement" && engagementStarted && f.suppliers_discovery_complete === 0) blockingReason = "Awaiting completion of the first supplier discovery meeting";
  else if (currentStage === "RFQs" && f.rfqs_total === 0) blockingReason = "No RFQ has been issued";
  else if (currentStage === "Quotations" && f.valid_quotation_suppliers === 1) blockingReason = "Only one valid quotation has been received";
  else if (currentStage === "Comparison" && enoughQuotes && !selectionRecorded) blockingReason = "Supplier-selection decision required";
  else if (currentStage === "Finance OS Mapping" && !mappingTerminal) blockingReason = "Approved quotation not yet mapped to Finance OS";
  else if (currentStage === "Complete" && f.critical_actions_open > 0) blockingReason = "Critical action remains open";

  return {
    work_package_id: workPackageId,
    current_stage: currentStage,
    next_action: nextAction,
    blocking_reason: blockingReason,
    stages,
    summary: {
      suppliers_identified: f.suppliers_identified,
      suppliers_verified: f.suppliers_verified,
      suppliers_shortlisted: f.suppliers_verified,
      suppliers_contacted: f.suppliers_contacted,
      meetings_held: f.discovery_meetings_completed,
      rfqs_sent: f.rfqs_sent,
      quotations_received: f.quotations_received,
      valid_quotations: f.valid_quotations,
      finance_mappings_complete: f.finance_mappings_complete,
      critical_actions_open: f.critical_actions_open,
      linked_evidence_count: f.linked_evidence_count
    },
    calculated_at: calculatedAt
  };
}

export async function calculateProcurementProgress(workPackageId: string, db: Db = pool) {
  if (!uuidPattern.test(workPackageId)) throw progressError("Invalid work-package id", "invalid_work_package_id", 400);
  const result = await db.query(`
    SELECT wp.status AS work_package_status,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id) suppliers_identified,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id AND s.procurement_status IN('Verified','Contacted','Discovery Meeting','RFQ Sent','Quote Received','Comparison','Selected','Closed')) suppliers_verified,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id AND s.procurement_status IN('Verified','Contacted','Discovery Meeting','RFQ Sent','Quote Received','Comparison','Selected','Closed')) suppliers_shortlisted,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id AND s.procurement_status IN('Contacted','Discovery Meeting','RFQ Sent','Quote Received','Comparison','Selected')) suppliers_contacted,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id AND s.procurement_status IN('Discovery Meeting','RFQ Sent','Quote Received','Comparison','Selected')) suppliers_discovery_complete,
      (SELECT count(*)::int FROM rd_lab.suppliers s WHERE s.work_package_id=wp.id AND s.procurement_status='Selected') suppliers_selected,
      (SELECT count(*)::int FROM rd_lab.interactions i WHERE i.work_package_id=wp.id) interactions_count,
      (SELECT count(*)::int FROM rd_lab.interactions i WHERE i.work_package_id=wp.id AND lower(i.interaction_type) LIKE '%meeting%') discovery_meetings_completed,
      (SELECT count(*)::int FROM rd_lab.rfqs r WHERE r.work_package_id=wp.id) rfqs_total,
      (SELECT count(*)::int FROM rd_lab.rfqs r WHERE r.work_package_id=wp.id AND r.status IN('Draft','Ready')) rfqs_draft_or_ready,
      (SELECT count(*)::int FROM rd_lab.rfqs r WHERE r.work_package_id=wp.id AND r.status IN('Sent','Acknowledged','Clarification','Response Received','Closed')) rfqs_sent,
      (SELECT count(*)::int FROM rd_lab.rfqs r WHERE r.work_package_id=wp.id AND r.status='Response Received') rfqs_response_received,
      (SELECT count(*)::int FROM rd_lab.rfqs r WHERE r.work_package_id=wp.id AND r.status IN('Response Received','Declined','Closed')) rfqs_terminal,
      (SELECT count(*)::int FROM rd_lab.quotations q WHERE q.work_package_id=wp.id) quotations_received,
      (SELECT count(*)::int FROM rd_lab.quotations q WHERE q.work_package_id=wp.id AND
        (nullif(trim(q.scope),'') IS NOT NULL OR nullif(trim(q.deliverables),'') IS NOT NULL) AND
        coalesce(q.net_amount,q.gross_amount,q.minimum_amount,q.likely_amount,q.maximum_amount,q.one_off_development_cost,q.materials_cost,q.testing_cost,q.tooling_or_nre,q.estimated_unit_cost) IS NOT NULL AND
        lower(coalesce(q.decision_status,'')) NOT IN('rejected','superseded')) valid_quotations,
      (SELECT count(DISTINCT q.supplier_id)::int FROM rd_lab.quotations q WHERE q.work_package_id=wp.id AND
        (nullif(trim(q.scope),'') IS NOT NULL OR nullif(trim(q.deliverables),'') IS NOT NULL) AND
        coalesce(q.net_amount,q.gross_amount,q.minimum_amount,q.likely_amount,q.maximum_amount,q.one_off_development_cost,q.materials_cost,q.testing_cost,q.tooling_or_nre,q.estimated_unit_cost) IS NOT NULL AND
        lower(coalesce(q.decision_status,'')) NOT IN('rejected','superseded')) valid_quotation_suppliers,
      (SELECT count(*)::int FROM rd_lab.quotations q WHERE q.work_package_id=wp.id AND nullif(trim(q.recommendation),'') IS NOT NULL AND lower(coalesce(q.decision_status,'')) NOT IN('rejected','superseded')) recommendations_recorded,
      (SELECT count(*)::int FROM rd_lab.quotations q WHERE q.work_package_id=wp.id AND lower(coalesce(q.decision_status,'')) IN('approved','selected','no supplier selected','deferred')) selection_decisions_recorded,
      (SELECT count(*)::int FROM finance_os.decisions d WHERE d.status='approved' AND d.metadata->>'work_package_id'=wp.id::text AND
        lower(concat_ws(' ',d.title,d.decision,d.rationale)) ~ '(single[- ]source|unique capability|exclusive technical pathway|grant deadline|unavailable alternatives)') single_source_justifications,
      (SELECT count(*)::int FROM rd_lab.finance_mappings m WHERE m.work_package_id=wp.id) finance_mappings_total,
      (SELECT count(*)::int FROM rd_lab.finance_mappings m WHERE m.work_package_id=wp.id AND m.mapping_status='Ready to Map') finance_mappings_ready,
      (SELECT count(*)::int FROM rd_lab.finance_mappings m WHERE m.work_package_id=wp.id AND m.mapping_status IN('Mapped','Rejected','Superseded')) finance_mappings_complete,
      (SELECT count(*)::int FROM rd_lab.technical_findings f WHERE f.work_package_id=wp.id AND f.status='Accepted') accepted_pathways,
      (SELECT count(*)::int FROM rd_lab.action_items a WHERE a.work_package_id=wp.id AND a.priority='Critical' AND a.status NOT IN('Complete','Cancelled')) critical_actions_open,
      (SELECT count(DISTINCT el.evidence_id)::int FROM finance_os.evidence_links el WHERE
        (el.entity_type='rd_work_package' AND el.entity_id=wp.id) OR
        (el.entity_type='rd_supplier' AND el.entity_id IN(SELECT id FROM rd_lab.suppliers WHERE work_package_id=wp.id)) OR
        (el.entity_type='rd_rfq' AND el.entity_id IN(SELECT id FROM rd_lab.rfqs WHERE work_package_id=wp.id)) OR
        (el.entity_type='rd_quotation' AND el.entity_id IN(SELECT id FROM rd_lab.quotations WHERE work_package_id=wp.id))) linked_evidence_count
    FROM rd_lab.work_packages wp WHERE wp.id=$1
  `, [workPackageId]);
  if (!result.rows[0]) throw progressError("Work package not found", "work_package_not_found", 404);
  return deriveProcurementProgress(workPackageId, result.rows[0] as ProgressFacts);
}
