# Growth OS production drafts (Phase 5D)

Production extends existing `content_items.production_state` and `media_assets.production_provenance`. It does not create content, media, scheduling, publishing or metric tables. Candidate histories retain IDs, origin, request/version, evidence/brief fingerprint, actor, parent edit, rejection and separate approvals. `narrative_decisions` records founder actions. Existing content/campaign/platform/tracked-link IDs remain canonical for subsequent outcomes.

## Brand and generation

`production-generation.ts` pins the website's Inter typeface, KLPS logo and final `:root` brand palette from Website-UX-UI/src/index.css (magenta/pink/lavender/violet/ink), with the existing signature gradient. The logo is a byte-identical copy of src/assets/logo.webp. Inter and its OFL licence are bundled to render consistently without browser/font requests. A 1080×1350 portrait layout, 84px safe margin, readable typography and role/position treatments are production-specific settings, not a replacement brand system.

The `VisualGenerator` interface returns validated media bytes and an honest origin. `klps-designed-v1` renders real JPEGs locally using resvg and sharp. It is **designed/template artwork**, not AI imagery or genuine photography. Request provenance includes narrative theme, source evidence, purpose, grid position, adjacent content references, eligible existing asset IDs and CTA. Reuse of real/approved media is a founder selection, not automated visual matching. Six designed Instagram positions can render; three genuine reservations cannot.

The optional OpenAI GPT Image 1.5 adapter follows the official Images API contract and has injected-transport tests only. It generates abstract texture, then applies the canonical logo and typography locally. It is deliberately absent from the production registry; no environment variable can activate it. No external AI provider, API key or billable generation is activated. Registering the prepared adapter and adding durable cost admission requires founder approval of the provider/model, a usage/spend limit and the data sent to it. The current provider selector fails closed for any external provider. There is no hidden paid API fallback.

Copy uses a deterministic evidence-template provider with deliberately different LinkedIn, Facebook, Instagram, X, TikTok and Snapchat structures. Only canonical supported source states supply factual claims. Free-text brief notes are guidance, not machine-verified facts. Founder edits are preserved as new unapproved versions and require explicit evidence/disclosure review. This is not general-purpose AI copywriting.

## Founder flow

Intelligence → existing narrative plan → optionally add missing platform briefs → review/approve sequence → Studio → Content production. Prepare a copy candidate; render a designed image or attach existing profiled media; preview and independently approve copy/asset. Editing creates a new unapproved copy while retaining asset approval. Regenerating/selecting another asset does not approve it. Candidates are capped at 80 per brief to bound record growth. Version checks serialize founder changes with the existing narrative advisory lock.

Genuine slots provide hooks, scripts, shots, aspect ratio, duration, platform and deadline. Upload via existing private planning-media intake; record origin/format; attach as genuine or edited genuine (with edit notes). Production-generated artwork cannot be relabelled genuine through media profiling.

Conversion briefs offer explicit create/reuse of the existing content-bound tracked link. Regenerate copy after binding. Instagram's guidance provides the profile URL; it does not pretend caption URLs are clickable. Unknown attribution remains unchanged.

## Approval and execution

Generation does not approve anything. No production endpoint creates social variants, jobs, delivery URLs or external posts. Asset approval uses `media_assets.approved_for_use`; selected production approval additionally binds the reviewed media fingerprint to that content brief. Source confidentiality, accepted/current evidence, planning approval, accepted/included brief and candidate fingerprints are checked live. Studio direct copy edits invalidate copy approval; substantive media/provenance edits revoke asset use. Changed briefs require new candidates. API errors roll back candidate/content changes; failed media persistence attempts clean up the newly uploaded object.

Provider job approval/execution and Snapchat handoff also require current production approval where production_state exists. The approved execution copy and publishing-media source must match the production selections. Existing provider approval remains mandatory. Legacy content without production candidates keeps its existing gates. X/TikTok execution policies and Login Kit/provider credentials are untouched.

All previews are authenticated, no-store private source previews. Raster output contains no source document, storage key, secret or external image fetch. `GET /api/growth/production` projects the existing planner data with effective approval status. `POST /api/growth/production/:id` requires the workspace founder, optimistic version and an explicit action. Adding platforms uses `/api/growth/narrative-plans/:id/platforms` and resets planning approval.

## Release

Apply `scripts/release-growth-production.cjs` using the established locked migration process before backend deployment, after backup and local rehearsal. Migration 20261003_growth_production.sql is additive: two nullable JSONB columns, a JSON object constraint and approval invalidation triggers. No backfill or production content generation is performed during release. No new environment variables are required. Node production installs must include optional native packages for sharp/resvg; Railway's normal npm install handles these.

Validation includes native JPEG rendering, platform copy/truthfulness, protected genuine slots, real restored-schema state transitions, dedup/version checks, approval invalidation, private previews, a real local browser flow and zero social side effects. Official rendering references: https://github.com/thx/resvg-js and https://sharp.pixelplumbing.com/api-output/ .

## Initial trial: ChatGPT-assisted image briefs

The default image workflow is now manual ChatGPT assistance. `image_brief` stores a versioned brief in the existing content item's production_state, with the evidence/brief fingerprint, complete prompt and `awaiting_generated_asset` state. It clears the selected image, retains candidate history and leaves copy approval independent. No API is contacted. The Studio provides a visible prompt and Copy generation brief; clipboard failure leaves the selectable text available.

The prompt contains brand rules, purpose, platform/format, grid context, exact allowed text, factual limits, CTA treatment and relevant approved asset labels. Private files, storage keys and delivery URLs are never embedded or sent automatically. Founder-provided reference files remain a manual disclosure decision.

Upload ChatGPT image uses the existing 5C private upload route and then explicitly associates the media with a current image brief. The founder attests external ChatGPT generation and records notes/model/date/edits if known. JPEG/PNG decoding and 4:5 dimensions are checked server-side. Metadata retains originating brief/version/content/campaign/opportunity/Insight plus pixel dimensions and provenance history. The candidate is labelled `chatgpt_assisted_visual` and `asset_received`, not Growth-OS-generated. Media and copy still require separate approvals. Existing generation provenance cannot be overwritten, stale briefs are rejected and genuine slots cannot request or receive generated replacements. Invalid uploads remain private and unapproved in the existing library.

There is no additional migration or environment configuration. The local template renderer/history remains available internally; the UI directs new image work through the ChatGPT-assisted path. The optional billable adapter remains unregistered and disabled. Image API spend during this workflow is zero because no image API request is issued.
