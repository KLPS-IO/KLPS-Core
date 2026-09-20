# Growth OS approved media delivery

Implemented against KLPS-Core commit 17de014 in an isolated local checkout. No production access, migration, upload, deployment, or publishing was performed.

## Decision

Keep media_assets as the catalog and the existing R2 service/bucket as the private object store. publishing_assets contains immutable uploaded publishing versions linked to that catalog; media_deliveries contains provider-specific, expiring capabilities. This avoids trusting editable catalog storage_key values as authority to expose a private object. Existing source uploads, private downloads and generic media CRUD are unchanged.

This initial transport supports JPEG images up to 8 MiB. It is shared by all six registered providers. Other media formats require their own validated transport support; provider dimensions, ratios and API restrictions belong in adapters. Existing adapters still refuse automatic publication. prepareInstagramRequest only prepares requests: it performs no network I/O and is not a publishing worker.

Flow: existing media asset -> upload immutable publishing version -> explicit approval -> issue delivery -> prepare provider container request -> future approved executor -> existing social_publish_jobs.provider_post_id/status -> existing social_metric_snapshots. Deliveries may reference an existing workspace/provider-matched publish_job_id. New generic provider_container_id/status columns prepare jobs for two-stage execution. Container execution, reconciliation, analytics collection and a publishing worker are not added by this patch.

## Security

Founder/admin authentication protects upload, approval, issuance, state lookup and revocation. Meta reviewers cannot use these routes. Only the opaque retrieval route bypasses founder auth. No bucket policy changes, storage-key redirects or storage credentials in delivery responses. URLs contain 256-bit random bearer capabilities; only their SHA-256 hashes are stored. They last 72 hours and are stable during that lifetime. Save issuance responses securely: URLs cannot be recovered from hashes; issue another when needed.

Every request checks database approval, source approval, expiry and revocation, then checks MIME, byte size and SHA-256. Responses use image/jpeg, nosniff and no-store. Invalid/missing/revoked/expired requests all return empty 404s. Source approval withdrawal permanently revokes versions; reapproving the catalog does not revive old capabilities. Database triggers prevent byte metadata mutation and revoked-version resurrection. Revocation prevents future fetches; it cannot erase bytes already downloaded by a provider.

Application access logs redact delivery capabilities. Configure reverse proxy/CDN/APM logs to do the same; disable caching and browser challenges for this route. Apply normal edge rate limits. Anyone possessing a live URL can fetch its explicitly approved image; provider labels are usage attribution, not proof of the requesting server's identity.

## Configuration and deployment (manual, not executed)

1. Review/apply server/sql/20260920_growth_media_delivery.sql after existing Growth/social migrations. Additive tables, constraints and triggers; two new publish-job columns. Migration is a once-only migration, not rerunnable.
2. Deploy the backend changes. Set GROWTH_MEDIA_PUBLIC_ORIGIN to the public backend HTTPS origin, without a path. The /api/growth/media-delivery/* route must reach this backend without login or bot challenges.
3. Reuse CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_BUCKET and optional CLOUDFLARE_R2_ENDPOINT. No public R2 bucket or new signing secret is required.
4. Keep the existing database/auth/social environment settings. No new Meta credentials or login configuration is automatically enabled.

## Test-image runbook

Use the ordinary authenticated Growth API with a founder/admin session:

1. POST /api/growth/media with JSON {"filename":"klps-social-review.jpg","display_name":"KLPS temporary publishing test","asset_type":"image","mime_type":"image/jpeg","approved_for_use":false}. Save record.id as MEDIA_ID.
2. POST /api/growth/media/MEDIA_ID/publishing-assets, multipart field file=server/fixtures/klps-social-review.jpg. Save record.id as PUBLISHING_ASSET_ID. This uploads private bytes via the existing R2 service.
3. Review the image, then PATCH /api/growth/media/MEDIA_ID with {"approved_for_use":true}.
4. POST /api/growth/publishing-assets/PUBLISHING_ASSET_ID/approve with {"approved":true}.
5. POST /api/growth/publishing-assets/PUBLISHING_ASSET_ID/deliveries with {"provider":"instagram"}. Optionally include an existing publish_job_id. Save record.id and record.url. This is the exact public HTTPS image URL to use; no hard-coded test endpoint exists.
6. Verify record.url with a cookie-free GET and HEAD before creating the Meta container.
7. GET /api/growth/publishing-assets/PUBLISHING_ASSET_ID/deliveries reports state without revealing capabilities/keys.
8. DELETE /api/growth/media-deliveries/DELIVERY_ID revokes a URL. PATCH source approved_for_use=false revokes all its publishing versions permanently.

There is no live test-image URL yet: generating one requires the expressly excluded deployment/migration and production upload/approval steps. The local fixture is ready.

## Next Meta request after the URL exists

For the requested instagram_business_content_publish permission use Instagram Login and its Instagram user token (with instagram_business_basic). Confirm the token's IG identity is 17841466528859006; do not mix a Facebook Page token with this scope.

POST https://graph.instagram.com/v23.0/17841466528859006/media
Authorization: Bearer <Instagram user token>
Content-Type: application/x-www-form-urlencoded

image_url=<record.url from delivery issuance>
caption=KLPS Growth OS publishing connection test. Temporary test post.

This creates a container only. The separate publishing call, when explicitly desired, is POST /v23.0/17841466528859006/media_publish with creation_id=<returned id>. Do not run it as part of deployment. Graph API Explorer must support the Instagram host/token; otherwise use an API client for this request. A Facebook-host Explorer call instead tests the Facebook Login route and requires instagram_content_publish, not instagram_business_content_publish. A container call alone may not satisfy Meta's publish-permission review counter.

Official Meta collection: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## Validation

npm run build: passed.
npm test: 291 tests, 290 passed, 1 skipped, 0 failed.
Focused new tests: 7 passed.
Disposable PostgreSQL 16 test plus local Express GET/HEAD: passed migration, private denial, explicit approval, correct bytes/MIME, no-store, invalid tokens, expiry, revocation, permanent withdrawal, immutable object keys, workspace isolation and provider delivery state. Object storage was mocked; live R2/Meta calls were not performed.

scripts/test-media-delivery-local.cjs uses only a disposable loopback DB named growth_media_delivery_test on port 55479; it requires an empty database and does not use DATABASE_URL. The minimal fixture verifies new SQL against relevant table shapes, not a full production schema restore. Production deployment should follow the usual staging migration checks.
