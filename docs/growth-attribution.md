# Phase 5A: deterministic first-party waitlist acquisition

Canonical records: `growth_os.tracked_links` (unchanged link ownership),
`growth_os.tracked_link_visits` (consented first-touch session visits), and
`public.waitlist_signups.acquisition_visit_id` (first acquisition). Community
profiles still reference the canonical waitlist identity. No second person store
or metric-snapshot import is created. GET `/api/growth/acquisition` derives counts
from raw records; manually entered metric snapshots are not attribution truth.

Studio creates content-bound links, validating workspace ownership and campaign
consistency. Existing Settings links still work, limited to HTTPS KLPS homepage
and waitlist destinations. Link source names the intended platform, not a verified
social referrer: forwarded links retain the original source. Campaign/content IDs
are snapshotted on a visit so later content edits do not rewrite acquisition.

On a public KLPS page, a valid `klps_ref` is held in memory until explicit consent.
Only after opt-in does the browser POST `/api/waitlist/visits`, store an opaque
sessionStorage token and carry it into waitlist submission. First permitted touch
wins for that tab/session, for at most 24 hours. No cross-site cookies, IP addresses,
user agents, email addresses or full landing URLs are stored in visit rows. Only a
SHA-256 hash of the token is stored server-side. This is an unverified acquisition
signal, not proof of a qualified person or a bot-proof metric. Declining, stopping
measurement before signup, missing storage, invalid links/tokens or expired tokens
leave the signup unknown. Already consented visit counts remain historical evidence.

The unique-signup rule is the existing case-insensitive email identity, with input
trimmed/lowercased. A single atomic UPSERT preserves `created_at`, `source` and
`acquisition_visit_id` on repeats. A database trigger additionally prevents changing
first acquisition, including retroactively attributing an unknown/legacy record.
Name/phone can still update as before. Neither email aliases nor different email
addresses are inferred to be one person. No email verification or qualification
is claimed. Existing community qualification remains a separate assessment.

Reporting is all-time and grouped by link/platform/campaign/content. Visits means
consented first-touch session visits, not every pageview or unique people. Unique
signups means first inserts into the canonical email identity table. Visit conversion
is visits containing at least one new signup divided by visits; several identities
can share a session. Company-wide unknown signups include historical records and
are not assigned to an invented workspace. No multi-touch causal inference.

X: server-side API execution and API scheduling are disabled, including existing
approved jobs. Existing adapter, encrypted credentials, OAuth scopes and history
remain. Approval can use identity-only grants; the UI exposes approved copy/open X
and never marks a manual action as provider-confirmed published. Recording a
founder-confirmed manual post URL is left for a later phase.

## Release / verification

Apply `scripts/release-growth-attribution.cjs` `apply(client)` explicitly after a
private backup and local restored-schema rehearsal. It uses an advisory lock and
an atomic migration with a 5-second DDL lock timeout, checks existing email identity
ambiguities and recognises a complete prior application. Migration:
`server/sql/20261001_growth_attribution.sql`. Apply before backend deployment, then
deploy frontend. No new environment variables. Do not run this through request DDL.

Run `npm run build`, `npm test`, and the opt-in PostgreSQL tests with
`GROWTH_ATTRIBUTION_TEST_DATABASE_URL=postgresql://127.0.0.1:55481/growth_attribution_test`.
That database must be an isolated restore with the migration applied. The integration
test explicitly rejects nonlocal targets. Run the X manual-policy integration test
with its separate existing `growth_x_publish_test` local database.

Founder acceptance: Studio → choose real content/campaign/platform → create/copy
bound link → clean browser → allow measurement → join with a new email →
Intelligence / Waitlist acquisition → refresh. Expect one visit, one unique signup
and 100% visit conversion on that new link. Repeat the same email: unique acquisition
must remain one. No social posting is necessary.
