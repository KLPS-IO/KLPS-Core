# Debt-finance preparation workspace — Pass 2

Financial OS Funding owns this workspace. `finance_os.debt_applications` is a proposed request, never a funding receipt or credit facility. This phase exposes internal preparation statuses only and fixes the decision state to `Not submitted`. There is no submission, accounting promotion, drawdown, repayment-schedule or workbook-generation endpoint.

## Data and provenance

The additive migration `20260923_debt_application_workspace.sql` adds five tables: application headers, application items, private PSB entries, immutable application history and immutable private PSB history. It depends on the existing company, users, canonical evidence and readiness privacy/release infrastructure. Items use server-validated section-specific fields for checklist, current financial position, budget, commercial inputs, reconciliation, 12-month forecast inputs and document readiness. Original file hashes and workbook cell mappings are independent of workbook presentation.

An item revision retains source/date/locator, pinned evidence metadata and file versions, extracted fields, classification, rationale/calculation basis, responsible party and next action. Updating evidence invalidates readiness until reviewed again. Explicit founder review checkpoints pin application/item/PSB revisions and current FOS observations. These are internal versions, never falsely labelled submitted versions. A future submission feature must append an immutable manifest referencing those exact versions and resulting document evidence; it must not mutate this history. Actual lender decisions, accepted facilities and accounting treatment need a separately authorised, evidenced workflow.

This reuses the existing PostgreSQL transaction wrapper, authenticated Data Room founder/admin gate, private canonical evidence/R2 storage, immutable-history pattern and server cash-authority policy. No separate document store, ledger or finance model is introduced. Application data cannot populate the general canonical-model export or investor Data Room.

## Personal data boundary

Only the authenticated founder/admin who owns the application can access it; guessing another application's UUID returns 404. PSB figures, provenance and history have a separate endpoint and tables. The main workspace returns completeness and indicative affordability wording only. Private responses are `private, no-store`; the browser loads personal values only on opening the PSB and clears them on leaving. No personal values are saved in browser storage, generic application history or exports. Existing private canonical evidence policy applies to linked documents. Prefer short source references and extracted amounts; uploading personal statements is not required by this intake. Do not store credentials, complete card/account numbers or credit reports. Validation rejects unknown fields and common sensitive-number/credential patterns; this is data minimisation, not a guarantee that arbitrary free text is automatically redacted.

PSB mirrors official monthly rows E25:E32 and E36:E56; annual figures are derived. Unknown differs from explicit zero and reasoned non-applicability. Reviewed amounts require dated source provenance, evidence period and explicit confirmation. Only ongoing personal income/expenses belong here. No company or Sovereign income is inferred. The new proposed loan repayment is excluded from existing credit expenses and deducted once in the private indicative affordability view, not posted into company accounts.

## Initial evidence treatment

£7,000 / 60 months is proposed; the 7.5% annual rate checked 23 September 2026 gives an indicative £140.27 monthly payment. Lender terms/rounding remain subject to confirmation. FounderCatalyst is £995 net + provisional £199 VAT = £1,194 gross, with supplier/eligibility evidence missing. £5,806 stays unallocated. Ignitec is a candidate only with cost unknown. No additional expenditure is invented to balance the request. Founder can reduce proposed amount.

Existing FOS cash authority, dated credit observations, engagement budgets, VAT return observations and active/founder-paid expense counts are read live. They do not establish reconciled cash, current liabilities or current revenue. Historical Pass 1 summaries remain explicitly dated, review-required notes. Credit is never cash. Forecast has 12 blank input months per cash category, explicit timing basis and start month. Inputs are not a calculated forecast; no equity/grant/sales/VAT recovery assumptions are seeded. Fresh cash evidence and completed financial/forecast/PSB inputs are required before the readiness indicator can become positive.

## Release controls

1. Review diff; run backend build/full tests, frontend typecheck/build and targeted lint; run the guarded database integration test using an empty localhost:55481 `debt_workspace_test`.
2. Read production schema, take restricted custom-format PostgreSQL backup and hash it. Restore to isolated localhost `debt_release_test`. Rehearse the operator importer twice (second run must be idempotent). Verify unrelated financial/social fingerprints and real HTTP founder/non-founder/anonymous controls locally.
3. Original workbook/guide bytes must match the template hashes. Upload unchanged originals through existing private R2 storage to content-addressed `restricted/debt-applications/sources/` paths and verify downloaded hashes. No public URLs are issued. Operator manifest remains outside Git.
4. `scripts/release-debt-workspace.cjs` applies the reviewed migration, creates the internal workspace, registers original sources in canonical evidence, and links their exact versions in one transaction. It takes a release advisory lock, records migration/manifest hashes in the existing release ledger, refuses partial/conflicting state and has no startup hook. This is not a generic seed of financial actuals.
5. Follow existing main-branch GitHub → Railway backend / Vercel frontend release flow. Verify health, anonymous rejection, deployment commit and that all unrelated ledger/social fingerprints remain unchanged. No application is submitted.

Rollback is additive: hide the Funding workspace if needed, preserve history and private evidence. Do not restore the full database over later business activity or remove privacy restrictions. No new production environment variables are required.

## Validation

Unit tests cover nullable values, repayment arithmetic, unallocated/unknown budget, VAT consistency, blank forecast/commercial inputs, exact PSB row coverage, single deduction, stale metadata/file-version handling and access gate ordering. The guarded PostgreSQL suite executes migrations and service mutations, tests cross-applicant denial, optimistic conflicts, immutable original metadata/checksum, private-history isolation, rejected sensitive fields, forbidden approval state, versioned internal review and absence of financial postings. Local restored-schema HTTP/browser checks supplement these tests; they do not submit anything externally.
