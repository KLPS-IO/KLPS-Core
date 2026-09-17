// Read-only review metadata. There is deliberately no execution or ownership-write API.
export function subdivisionReview(activity: {kind: string; payload?: Record<string, unknown>}[]) {
  const decision = activity.find(a => a.kind === 'founder_decision' && a.payload?.decision_key === 'subdivision-review-20260917');
  if (!decision) return null;
  return {
    status: 'APPROVED IN PRINCIPLE — PENDING FOUNDERCATALYST / FINAL EXECUTION REVIEW',
    scope: 'PROPOSED_NOT_CURRENT', passed: false, executed: false, filed: false,
    shareholder: 'Emma Louise Mendez', share_class: 'Ordinary', shares: 10000,
    nominal_value: 0.0001, nominal_capital: 1, amount_paid: 1, amount_unpaid: 0, ownership: 1,
    preparation_date: '2026-09-17', legal_effective_date: null, resolution_passing_date: null,
    register_update_date: null, companies_house_submission_date: null, companies_house_acceptance_date: null,
    review_evidence_id: decision.payload?.review_evidence_id ?? null,
  };
}
