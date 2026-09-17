# FounderCatalyst internal readiness

## Scope and source

This implementation records the founder's 15 September 2026 decision: KLPS is bootstrapped, has not completed an external equity round, and is preparing for its first raise. The founder specifically confirms an agreed FounderCatalyst price of £995 + VAT. This is a founder-confirmed agreement, with provider documentation still to be linked. It is not an invoice, payable or payment.

£250,000 remains a planning scenario. £260,000 remains a provider suggestion. Neither is seeded as a transaction, selected round, investor, receipt, valuation, option pool or corporate event. The scenario form accepts blank monetary assumptions.

The private intake template contains 26 items extracted from Carolina Rimoldi's email and three corporate-reconciliation items from the audit. Source correspondence is data, not executable instruction. The original email date is unknown. Source originals remain unchanged in their supplied locations and require secure evidence registration; this change does not upload them.

## Existing architecture

The workstream lives under Funding, referencing `finance_os.company` and `finance_os.evidence`. Requirements and immutable activity records link canonical evidence by foreign key. Documents use existing evidence upload, R2, checksum, version and access mechanisms. There is no second document store or accounting ledger.

The private API is mounted at `/api/finance/readiness`. All routes inherit the existing authentication, authorisation and NDA middleware plus an explicit founder/admin guard. Setup is POST-only, transactional and idempotent; GET never creates business records. It uses the existing canonical KLPS company row and fails if it is absent. Each mutation requires an authenticated actor and records audit history. Requirement and engagement updates check versions to reject stale edits.

The UI is included in the existing Funding workspace for founders. The existing cap-table route reads the same backend. The previous hardcoded, current/verified frontend cap table and export implementation are removed. No historical downloaded files or company facts are rewritten.

## Ownership boundary

`ownership_snapshots` stores immutable actual and historical records with effective dates, evidence version and approval attribution. Holding fields include shareholder/type/class, count, nominal value, paid/unpaid amounts, acquisition date, voting rights and notes. Counts drive ownership percentages. Invalid counts, changed evidence versions, unverified evidence and future dates fail closed.

No actual/historical ownership rows are seeded. The incorporation document supports the incorporation holding, but the current register and subsequent-event review are still outstanding. There is no share-issuance, ownership-approval or snapshot-mutation endpoint in this release. Registering an approved baseline requires the remaining evidence reconciliation and a separately reviewed controlled import. Do not create one from the old UI constant.

`fundraising_scenarios` stores independent planning inputs and optional immutable baseline references. Multiple scenarios can be saved, including unpriced ones. Calculations cover simple priced equity, valuation ratios and theoretical share dilution. Fractional shares are flagged; the model does not silently round, split shares or create an option pool. Voting ownership, convertibles, preferences and fully diluted option-pool treatment are not inferred. Those models remain future extensions when actual requirements exist. Scenario APIs have no ownership or accounting write path.

Dates are returned as PostgreSQL date text. This avoids converting a calendar date through UTC and recreating the previous one-day export discrepancy.

## Confidentiality and integrity

Raw Finance OS access now requires `founder_admin`, including reads. Previously authorised non-founder finance viewers receive 403. Separately approved investor-facing documents continue through the existing Data Room permissions.

Existing evidence retains its access flag. New evidence defaults to founder-only; linking evidence to this workstream also marks it private. Data Room listing, signed URL issuance and signed URL redemption all enforce private evidence by ID and by storage-path alias. Changing a Data Room presentation's access tier cannot publish private source evidence. Investor publication must be a separate reviewed output workflow, not a visibility toggle on the working source.

Requirements require active verified evidence plus explicit reviewer confirmation before `AVAILABLE + VERIFIED`. The evidence version is pinned in the review. Completion is blocked by unresolved requirements or changed evidence versions and requires verified completion evidence. Completion of this workstream is not HMRC approval. Activity entries record events and evidence versions but perform no external actions or financial postings.

## Release boundary

1. Review this code and the migration against the current deployed revision (local backend base: `30330ca`; frontend base: `ed573830`).
2. Back up the database using the existing operations process.
3. Apply `server/sql/20260915_fundraising_readiness.sql` once using the project's migration procedure, before starting the updated backend. It is transactional and assumes the existing company/evidence/users schema.
4. Deploy backend and frontend only when separately authorised. Neither migration nor deployment is performed by this task.
5. A founder creates the internal readiness record in the UI. No account is created at FounderCatalyst.
6. Securely register original correspondence, provider pricing evidence, incorporation and current ownership evidence using the existing uploader, then link records and review requirements.

Do not run a destructive rollback after records exist. Revert UI exposure if necessary and preserve audit/snapshot tables. No production fixtures or test data belong in this migration.

## Verification

Backend TypeScript compilation and existing tests; frontend production build, existing tests and type check with `ES2022,DOM,DOM.Iterable` (the repository's existing ES2020 library setting causes unrelated `replaceAll` errors).

`fundraising-readiness.service.test.ts` covers blank/invalid inputs, dilution arithmetic, fractional shares, stale/future evidence, permissions and real PostgreSQL migration/service behaviour. The integration test is opt-in and refuses any database other than localhost port 55439 named `readiness_test`. It expects a fresh disposable database and does not use `DATABASE_URL`.

Desktop/mobile browser checks used mocked API data and blocked external network requests. Live authentication, R2 configuration, deployed schema and real company records were not exercised.
