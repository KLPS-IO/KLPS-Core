# Growth OS social integration architecture

## Scope

Phase 4A establishes the secure provider-neutral connection, approval, scheduling,
metrics and audit boundaries. It does not enable direct publishing. LinkedIn member
identity connection is active; publishing, refresh and revocation remain
activation-gated. Other providers remain activation-gated until KLPS owns the
required developer applications and provider approvals.

Studio remains the editorial workflow. The social module owns connections and
delivery. Studio supplies an approved platform variant; it never calls a provider API.

## Source of truth

- `growth_os.content_items`: canonical Studio content.
- `growth_os.social_content_variants`: one provider-specific presentation of content.
- `growth_os.social_connections`: connection health and encrypted OAuth material.
- `growth_os.social_publish_jobs`: approval and scheduling lifecycle.
- `growth_os.social_metric_snapshots`: provider-neutral observed metrics.
- `growth_os.social_audit_events`: safe operational events without credentials.
- `growth_os.tracked_links`: canonical tracked destinations and direct attribution.

## Connection lifecycle

1. The founder opens Growth Settings and requests Connect.
2. The backend validates only that provider's environment.
3. The backend creates 256-bit OAuth state, stores only its SHA-256 hash, and creates
   a PKCE verifier for providers requiring PKCE.
4. The encrypted verifier and ten-minute authorisation record are stored server-side.
5. The frontend receives only the official provider authorisation URL.
6. OAuth start remains founder-authenticated. The authorisation record binds its
   hashed state to the initiating founder and that founder's Growth OS workspace.
7. The LinkedIn callback does not depend on a Railway session cookie. It atomically
   consumes the state only when it is unexpired, unused, belongs to LinkedIn, the
   stored initiator still owns the stored workspace, and that user is still a
   `founder_admin`. Expired, unknown, unauthorised and replayed state is rejected
   before LinkedIn is contacted.
8. An activated provider adapter exchanges the code and verifies the provider
   identity before the connection becomes healthy.
9. Access and any returned refresh token are AES-256-GCM encrypted before
   persistence.
10. Granted scopes come from the token response and are not inferred from the
   request. Refresh, health checks and revocation remain adapter responsibilities.
11. Disconnect clears encrypted token material and records an audit event.

The callback is state-authenticated and workspace-bound. This is intentional:
`klps.co.uk` and the Railway hostname are different browser sites, so the callback
must not rely on a cross-site cookie. Only OAuth start is allowed to create the
binding, and that route remains behind the normal founder session and role checks.
OAuth secrets, codes, raw state and tokens are excluded from structured audit
details.

## Adapter contract

Every adapter supplies:

- provider definition and capabilities;
- environment lookup;
- official authorisation URL construction;
- code exchange;
- token refresh;
- token revocation;
- health check;
- publishing.

Provider-specific request and response formats must remain inside the adapter.
No provider conditionals belong in Studio.

## Capability model

Configured capabilities include text, images, video, carousel, stories, reels,
threads, clickable links, scheduling, metrics, comment retrieval, draft upload and
direct publishing. A job must satisfy its required capabilities; feature parity is
never assumed.

## Approval and scheduling

The lifecycle is:

`draft → approved → scheduled → publishing → published`

with `failed`, `retry` and `cancelled` terminal/recovery states.

Scheduling is blocked until:

- copy approval exists;
- media approval exists;
- the destination is valid;
- the provider is connected;
- the last health check succeeded;
- required capabilities are available;
- the approval fingerprint still matches the content.

Changing copy, media or destination changes the fingerprint and invalidates approval.
Phase 4A creates no scheduler worker and makes no provider publishing call.

## Security model

- Every route inherits Growth OS founder authentication.
- Every query is scoped by `workspace_id`.
- OAuth state is hashed, short-lived and single-use.
- PKCE is used where the provider supports or requires it.
- Tokens and PKCE verifiers are encrypted with AES-256-GCM.
- `GROWTH_SOCIAL_ENCRYPTION_KEY` exists only in the backend environment.
- Secrets never enter React, browser storage, URLs, application responses or logs.
- Disconnect removes stored token material.
- Publishing requires an authenticated founder approval record.
- Safe audit logs record lifecycle outcomes without personal or secret fields.

Key rotation requires a controlled re-encryption migration or reconnection. Do not
replace the encryption key while active encrypted connections exist.

## Environment variables

Common:

- `GROWTH_SOCIAL_ENCRYPTION_KEY`
- `GROWTH_SOCIAL_FRONTEND_URL`

`GROWTH_SOCIAL_FRONTEND_URL` should be:

```text
https://klps.co.uk/innovation-lab/growth/settings
```

The backend allowlists the exact `https://klps.co.uk` origin and Growth settings
path. A missing or invalid value falls back to that same URL. Callback query
parameters cannot select a redirect destination.

LinkedIn:

- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `LINKEDIN_REDIRECT_URI`

LinkedIn currently requests only `openid profile` through the **Sign In with
LinkedIn using OpenID Connect** product. The product also makes `email` available,
but this connection does not request it because no email address is needed. The
verified `/v2/userinfo` subject is
persisted as a `member` account. No organisation/page identity is inferred, and no
member or organisation publishing scope is requested.

Set the production redirect URI exactly to:

```text
https://klps-lema-production.up.railway.app/api/growth/social/oauth/linkedin/callback
```

LinkedIn documents PKCE for native clients. This backend is a confidential web
client and uses LinkedIn's server-side code exchange with the client secret, so the
LinkedIn adapter does not enable PKCE. The provider-neutral implementation remains
available for adapters that support it.

Meta / Facebook Pages / Instagram Professional:

- `META_CLIENT_ID`
- `META_CLIENT_SECRET`
- `META_FACEBOOK_REDIRECT_URI`
- `META_INSTAGRAM_REDIRECT_URI`

X:

- `X_CLIENT_ID`
- `X_CLIENT_SECRET` (when required by the selected app type)
- `X_REDIRECT_URI`

TikTok:

- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REDIRECT_URI`

Snapchat is registry-ready but has no active environment contract in Phase 4A.

Generate the encryption key using a secure secret manager or:

```sh
openssl rand -base64 32
```

Never commit the result.

## Provider onboarding

The Settings response derives a checklist from the registry. It identifies the
developer account, application, scopes, redirect variable names and external review.
The backend never creates developer credentials and does not accept them through UI.

Recommended activation order:

1. LinkedIn member identity connection; publishing remains a separate activation.
2. Meta, activating Facebook Pages before Instagram Professional.
3. TikTok, initially using provider-supported draft upload where approval permits.
4. X, after confirming API tier and publishing volume.
5. Snapchat when an approved official publishing use case exists.

## Metrics and attribution

Adapters normalise reach, views, clicks, shares, comments, saves, profile visits and
followers. Conversion fields explicitly distinguish:

- direct tracked conversions;
- likely influence;
- unknown source.

No metric is created until an official response or canonical tracked event exists.
Timing alone is not attribution.

## Deployment

1. Review and apply `server/sql/20260730_growth_social_foundation.sql`, followed by
   `server/sql/20260730_linkedin_oauth_activation.sql`.
2. Configure only the credentials for the provider being activated.
3. Configure the exact production callback URL at both KLPS and the provider.
4. Deploy the backend before the frontend Connections UI.
5. Confirm missing providers show Setup required without affecting Growth OS.
6. For LinkedIn, enable **Sign In with LinkedIn using OpenID Connect** and confirm
   `openid` and `profile` appear on the application's Auth tab.
7. Run a founder-authenticated OAuth state/replay smoke test.
8. Inspect audit events and verify logs contain no token or authorisation code.

Both migrations are transaction-safe and seed no connections, jobs, credentials or
metrics.

### First LinkedIn live connection

1. Add the exact HTTPS callback above to the LinkedIn application's **Auth** tab.
2. Enable **Sign In with LinkedIn using OpenID Connect** in **Products**.
3. Set the three LinkedIn variables and the existing
   `GROWTH_SOCIAL_ENCRYPTION_KEY` in Railway; never expose them to the frontend.
4. Apply the two social migrations in order, if they are not already present.
5. Deploy the backend and sign in to Growth OS as `founder_admin`.
6. Call `POST /api/growth/social/oauth/linkedin/start` with the authenticated
   session and navigate the browser to the returned `oauth.authorization_url`.
7. Approve the identity consent on LinkedIn. The callback validates its server-side
   founder/workspace binding without a browser cookie, completes the connection,
   and redirects to:

   ```text
   https://klps.co.uk/innovation-lab/growth/settings?social_provider=linkedin&social_status=connected
   ```

   Failures use the same route with `social_status=failed` and one controlled
   `social_error` value: `access_denied`, `invalid_state`, `expired_state`,
   `missing_code`, `provider_exchange_failed`, `identity_lookup_failed`, or
   `connection_failed`. Raw provider errors and identifiers are never included.
8. Confirm the connection overview reports `provider_account_type: "member"` and
   the scopes LinkedIn actually returned. Confirm the audit event succeeded and
   application logs contain no OAuth code, token or secret.

Organisation/page discovery and all publishing require a separate LinkedIn product,
permissions and implementation. Do not enable Community Management or assume
organisation administrator rights for this identity-only connection.

## Troubleshooting

- **Setup required:** open the provider checklist and configure the listed backend
  environment variables.
- **OAuth state invalid:** restart Connect; state expires after ten minutes and is
  deliberately single-use.
- **LinkedIn token exchange failed:** confirm the client credentials, exact redirect
  URI and OIDC product/scopes. Restart Connect because the state and code are
  single-use.
- **Publishing blocked:** inspect approval, destination, health and capability
  readiness. Do not bypass the gate.
- **Decryption failure:** stop provider processing and reconnect through OAuth after
  confirming the configured encryption key. Never log encrypted or decrypted values.

## Adding a provider

Add a registry definition and adapter implementing the common interface, declare
capabilities and environment names, add contract tests, then add provider-specific
activation documentation. Studio and the Settings layout must not require refactoring.
