# FounderCatalyst readiness release — 17 September 2026

Founder/admin-only readiness and review. Current issued holding: Emma Louise Mendez, 1 fully paid £1 Ordinary share, 100%. The 10,000-share proposal remains approved in principle, unpassed, unexecuted and unfiled. No external submission, payment or corporate action is implemented.

FC04 is ready for provider review using the verified pre-split cap table. FC05 remains pending FounderCatalyst/final execution review. £995 plus VAT is founder-confirmed agreed cost, without a payable. £250,000/£260,000 are planning alternatives; valuation and equity terms remain unset.

## Controlled migration
`server/sql/20260915_fundraising_readiness.sql` is applied only by the explicit operator-run `scripts/release-foundercatalyst.cjs` with a restricted external manifest and `READINESS_RELEASE_APPROVED=20260917`. It does not run at startup or build time. Ledger ID: `20260917_foundercatalyst_readiness_review_v1`.

The importer uses the existing company and founder account. It inserts private evidence records, immutable current/historical snapshots, engagement/checklist and an append-only in-principle decision. Existing ownership documents are restricted without claiming their old contents are verified. Source artifacts stay outside Git. Repeated invocation with the same manifest is a no-op; a different manifest or pre-existing untracked readiness schema stops execution.

## Privacy
Raw Finance OS requires founder_admin. Data Room listing, signed-link issuance and redemption resolve restrictions by evidence ID and object-key alias. Restricted signed links require the current founder session and stream content without returning a transferable R2 URL. Finance private access returns an authenticated content route; the frontend retrieves a browser-local blob. Investor routes cannot retrieve the working evidence metadata, history, previews or exports.

## Validation
Run backend TypeScript/build and automated tests. READINESS_TEST_DATABASE_URL enables the disposable migration suite. Restore the pre-release backup into localhost readiness_release_test; run the importer, repeat for idempotency, and run scripts/test-readiness-release.cjs with that local connection. This test uses only local fixtures and checks real HTTP permissions, aliases, signed replay and scenario isolation. Never run it against production.

## Rollback
Retain the restricted pre-release PostgreSQL dump, its hash, release ledger, private object hashes and previous deployment commits. Prefer an additive forward fix. Application rollback must retain the new document restrictions: do not blindly revert to the previously permissive backend. Disable the FounderCatalyst frontend if necessary while keeping evidence private. Readiness tables may remain unused; do not delete append-only evidence/history. Full database restore requires separate review because it can overwrite later unrelated activity. The backup was test-restored locally.
