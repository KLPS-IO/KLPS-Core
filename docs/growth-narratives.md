# Phase 5B: canonical development → reviewed narrative

This extends Intelligence and the existing ranked Mission Control engine. It is a
rule-based intake envelope, not a second insight/strategy/calendar/content system.
The founder selects **Check company developments** to synchronise eligible source
states. No background scraping, AI interpretation, final copy or external action
runs. Acceptance creates a canonical `growth_os.insights` row; a separate explicit
**Create linked content idea** creates an existing `content_items` record at `idea`.
Campaign binding is optional and restricted to an existing workspace campaign.

## Intake contract and scope

`narrative-intake.ts` exposes kind, source ID, exact state, date, source version
where available, verification state, disclosure state and authenticated source path.
Only source work packages owned by the Growth workspace owner are eligible. The
current R&D interface supports WP1, so this release deliberately scopes R&D intake
to WP1. Community evidence is scoped directly to the Growth workspace.

Adapters read only allowlisted metadata:
- completed supplier discovery interactions with an explicit completed/held state;
- dated, non-rejected/non-superseded quotation records;
- findings both **Accepted** and **Verified**;
- work packages explicitly **In Delivery** or **Validated**;
- non-archived community feedback with quote-use permission AND founder quote approval.

The production source audit identified an actual Supplier Discovery Meeting marked
Discovery Completed (3 August 2026), and twelve findings still To Validate. The
former qualifies for a limited build-journey proposal; the latter are excluded.
No finding text, customer quote/identity, supplier name, attendees, technical notes,
commercial amount, finance document, attachment URL or object key is copied.

Finance/fundraising/application sources were inspected but are not integrated in
this slice: private application/PSB data, provider-service preparation and investor
conversations do not establish a publicly communicable funding/acceptance event.
No generic "Complete" label is interpreted as investment, partnership or acceptance.

## Significance and disclosure

Rules preserve the limited state: meeting is not partnership; quotation is not
appointment; verified individual finding/work package is not product or clinical
validation. The 0.8 confidence value is a fixed rule-match heuristic, explicitly
not independent source verification, a statistical probability or acquisition impact.
Narrative purpose can be awareness, education, credibility/nurture or conversion;
qualified waitlist growth is the objective without forcing a CTA into each idea.
Platform roles are conditional suggestions, not enabled provider capabilities.

Unknown disclosure requires explicit founder evidence/disclosure confirmation to
accept. Nonempty quotation confidentiality/publication terms conservatively produce
`restricted` and cannot be overridden by that checkbox. Source restrictions must be
resolved in the canonical system. Community permission is reported as recorded,
never inferred; private quotations are not copied even when permission exists.
Marking a source confidential suppresses all future versions. It also archives any
linked Insight. Existing content ideas remain historical founder planning records;
they have no generated script/caption or publishing approval. Separate content and
provider approval gates remain mandatory.

## Decisions, provenance and suppression

`narrative_opportunities` stores one envelope per workspace/source/semantic hash,
with optional canonical Insight/content links. Source facts cannot be edited through
this API. Founders edit the narrative, purpose, audience, timing, platforms and
planning notes before acceptance. `narrative_decisions` is an append-only founder
history protected by a database trigger. Decisions: accept, dismiss, defer (up to
90 days), confidential; internal refresh may record superseded and planning records
its linked content ID.

Repeated unchanged evidence preserves its decision indefinitely. The semantic hash
ignores version-only edits and R&D record-update timestamps, but includes actual
event dates, meaningful state, verification/disclosure and source identity. A source
change requires another review; missing/revoked/ineligible evidence blocks acceptance
and planning immediately. Refresh supersedes old active envelopes and archives their
linked Insights. Future deferrals survive source revisions; confidential sources
never resurface automatically. Accepted/historical source versions retain provenance.
Concurrent decisions and plan creation use a workspace advisory lock, row lock,
optimistic version check and transaction. Plan retries return the same content ID.

Mission Control gains review-opportunity and plan-accepted-opportunity candidates,
using its existing ranking, daily missions, duplicate keys/cooldowns and saved-outcome
evaluators. Linked Insights are excluded from the old generic review-insight candidate
path, preventing duplicate review recommendations. The existing Mission Control Opportunities panel now reads the same ranked candidates as the coach instead of the legacy secondary ranking; the old API field remains for compatibility. No mission is saved automatically.
Reviewer and investor roles cannot read or mutate the narrative endpoints.

## Release and verification

Explicit migration: `server/sql/20261001_growth_narratives.sql`, using
`scripts/release-growth-narratives.cjs` after private backup and local restored-schema
rehearsal. New tables only; no source edits/backfill, credentials or environment changes.
Deploy backend after migration, then frontend. Existing records are fingerprinted
before/after the migration. A release source refresh may prepare proposals only; it
must not accept on the founder's behalf.

Tests: `npm test`, `npm run build`; real DB suite with
`GROWTH_NARRATIVES_TEST_DATABASE_URL=postgresql://127.0.0.1:55481/growth_narratives_test`.
That suite rejects nonlocal targets and blocks provider fetches. Browser validation
covers genuine source → proposal → disclosure approval → Insight → Studio idea,
reviewer/investor denial and desktop/mobile rendering. Existing Phase 5A remains intact.
