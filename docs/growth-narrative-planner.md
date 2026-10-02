# Phase 5C: narrative planning within existing Growth records

## Ownership and lineage

A narrative plan is an existing `growth_os.campaigns` row, with one unique
`narrative_opportunity_id`, a provenance/constraint snapshot in `narrative_plan`,
and a separately versioned planning approval. The founder can bind an unused
existing campaign or explicitly create one. Only a current accepted Phase 5B
opportunity with an unarchived Insight can be planned. No background creation.

Each sequence position is an existing Studio `content_items` row. Its
`platform_brief` holds immutable source Insight/opportunity IDs, template slot,
media requirement, and editable role, order, brief, CTA intention, inclusion and
review decision. Creating a sequence is idempotent per opportunity; it deliberately
creates multiple distinct content positions, not duplicate provider parents.
The earlier Phase 5B seed idea remains historical. X and Snapchat composers now
bind a selected Studio content ID rather than copying it into a new parent.
Existing variants and tracked links therefore retain canonical content/campaign
lineage. Phase 5A link generation remains in Studio; conversion positions link there.
No raw attribution or metric truth is duplicated.

## Templates and media

Selective founder platform selection defaults to LinkedIn and Instagram. Each
channel has its own job and format; TikTok requires video-first talking points and
actual footage. Briefs are deterministic editorial structures, not final public copy
or claims inferred from private evidence. Source limitations accompany every item.
The commercial objective is qualified waitlist interest, but most roles have no
mandatory waitlist CTA. Reordering swaps intended dates in the UI; server validation
requires chronological order and a range at most 180 days.

Instagram uses nine distinct story beats, six designed/generated positions and
three genuine-media reservations. The profile preview reverses chronological order
(newest first). Excluding a position shows a gap; it never converts genuine media
into generated artwork. Requirements cannot be overwritten through item edits.

The existing `media_assets` library gains explicit origin (unknown, genuine founder,
genuine product/workshop, designed, generated), founder-supplied provenance history,
platform suitability, aspect ratio and duration. Existing assets remain unknown;
no provenance is guessed or backfilled. Reuse candidates require approval, stored
bytes, matching origin/media type/platform/ratio and plausible duration. The founder
must inspect topical relevance; matching metadata is not semantic video analysis.
Candidates do not bind themselves or silently satisfy a request.

Private JPEG/PNG/MP4 source upload reuses the R2 service and `media_assets` with
server-generated `growth-source` keys, a 40 MB limit and file-signature checks.
Authenticated preview returns the source to the founder; it never issues a public
URL. Provenance, approval and binding are separate steps. Existing JPEG publishing
versions/delivery URLs are unchanged. Video source readiness is not a claim that
all provider video-delivery formats are implemented. No image generator is added.

## Calendar and Mission Control

`content_items.scheduled_at` owns the intended content date, even at idea stage.
The Studio calendar projects those records with narrative purpose, source state,
brief/planning approval, asset readiness and manual/provider/handoff intent.
`calendar_entries` retains distinct filming, editing, review and other activities.
A publishing calendar row cannot duplicate a planner-owned content item; generic
CRUD cannot change planner-owned dates/lineage or delete planned records. Exclude
an item through the planner instead. Legacy standalone content/calendar records
are shown separately without rewriting historical data.
`social_publish_jobs.scheduled_for` is a separately approved execution intent,
shown with its status, never copied from planning dates. Nothing executes here.

Existing Mission Control ranking gains sequence approval, brief review and media
fulfilment actions. Metadata matches produce a reuse-review action instead of a
new filming request. Existing mission acceptance, cooldowns, keys and outcome
checks remain canonical. Actions link back to Intelligence. Planning generates
ranked suggestions; saving a daily mission still requires founder action.

## Approval and safety

Every included brief must be accepted before planning approval. Edits clear that
approval and use an optimistic version plus workspace lock and transaction.
Phase 5B's append-only decision history records sequence creation/edit/approval.
Known restrictions, stale evidence, archived Insight, confidentiality, revoked
assets and excluded briefs block planned provider job approval/execution/handoff.
Planning approval never sets social variant/job approval or publishes a post.
X and TikTok API execution/scheduling are disabled by policy; credentials and
adapters/history remain intact. Snapchat remains the existing approved web-link
handoff, not native full-screen photo/video publishing. No provider SDK changed.

## Release

`20261002_growth_planner.sql` is additive: campaign planning fields, one content
brief field, media provenance/format fields, unique source/slot indexes and a
calendar ownership trigger. `release-growth-planner.cjs` is explicit, transactional,
locked and repeat-safe. No startup/request DDL and no environment changes.
Backup affected schemas, rehearse against a restored local complete schema, compare
pre-existing business columns before/after (independently verified concurrent authentication audit activity is recorded separately), migrate, deploy backend then website.

Validation includes real database concurrency/lineage, 6+3 preservation, asset
reuse/revocation, confidentiality, mission deduplication, calendar ownership and
zero new social jobs/variants. Browser testing uses the actual local routes and
production build, a production-shaped isolated database, and an in-memory R2
transport; it proves UI flow, not production R2 or physical platform handoff.
