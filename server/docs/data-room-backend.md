# KLPS Innovation Lab / Investor Data Room Backend

## Recommended stack and auth approach

- Runtime: Express + TypeScript.
- Database: Postgres, schema `data_room`.
- Auth: passwordless email OTP, then Postgres-backed opaque sessions in secure HttpOnly cookies.
- Session expiry: `DATA_ROOM_SESSION_TTL_MS`, default 12 hours.
- OTP expiry: `DATA_ROOM_OTP_TTL_MS`, default 10 minutes.
- Document access: short-lived HMAC signed URLs, default 5 minutes via `DATA_ROOM_SIGNED_URL_TTL_MS`.
- Private files: Cloudflare R2 is preferred. Local private files still work with `DATA_ROOM_STORAGE_ROOT`.
- Email delivery: Resend sends OTP codes from `/auth/request-login`. The API never returns OTPs.

## Environment

Required in production:

```bash
DATABASE_URL=postgres://...
DATA_ROOM_SECRET=long-random-secret
DATA_ROOM_STORAGE_ROOT=/private/klps-data-room
DATA_ROOM_PUBLIC_API_URL=https://api.klps.co.uk
FRONTEND_ORIGIN=https://klps.co.uk
RESEND_API_KEY=re_...
EMAIL_FROM=KLPS Investor Data Room <investor-access@your-verified-domain.com>
CLOUDFLARE_R2_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET=klps-data-room
NODE_ENV=production
```

## Database schema

Migration: `server/sql/20260517_data_room.sql`

Tables:

- `data_room.users`: email, role, authorisation/revocation audit fields.
- `data_room.login_attempts`: login rate-limit and audit source.
- `data_room.login_otps`: one-time password hashes and expiry.
- `data_room.sessions`: hashed session tokens, expiry, immediate revocation.
- `data_room.nda_versions`: active NDA metadata and agreement hash.
- `data_room.nda_acceptances`: one acceptance per user per NDA version.
- `data_room.documents`: private document metadata and access policy.
- `data_room.document_categories`: controlled room sections and minimum access levels.
- `data_room.access_events`: append-only server audit log.

User roles:

- `founder_admin`
- `authorised_user`
- `pending_user`
- `revoked_user`

Document/user access tiers:

- `public_light`
- `investor_nda`
- `advisor_nda`
- `founder_only`
- `legal_only`
- `admin_only`

Default data room sections:

- `01_company_overview`
- `02_pitch_deck`
- `03_product_and_technology`
- `04_ip_and_defensibility`
- `05_market_and_customers`
- `06_financials`
- `07_validation_and_programmes`
- `08_brand_assets`
- `09_legal_and_compliance`
- `10_founder_only`

Founder seed:

- `emmamendez07@gmail.com`

Current NDA seed:

- Version: `KLPS NDA V1.0 - May 2026`
- Company: `KLPS Ltd`
- Watermark/footer: `Confidential Property of KLPS Ltd`

## User APIs

### POST `/api/data-room/auth/request-login`

Request:

```json
{
  "email": "investor@example.com"
}
```

Response:

```json
{
  "status": "success",
  "message": "If this email can access the data room, a one-time login code has been sent.",
  "expires_in_minutes": 10
}
```

### POST `/api/data-room/auth/verify-login`

Request:

```json
{
  "email": "investor@example.com",
  "code": "123456"
}
```

Response:

```json
{
  "status": "success",
  "authenticated": true,
  "user": {
    "id": "uuid",
    "email": "investor@example.com",
    "role": "authorised_user",
    "is_admin": false
  },
  "nda": {
    "current_version": "KLPS NDA V1.0 - May 2026",
    "accepted": false,
    "accepted_at": null
  },
  "session": {
    "expires_at": "2026-05-17T20:00:00.000Z"
  }
}
```

### GET `/api/data-room/session`

Returns whether the browser has a valid cookie session and whether the current NDA is accepted.

### GET `/api/data-room/nda/status`

Requires authorised session.

Response:

```json
{
  "status": "success",
  "current_version": "KLPS NDA V1.0 - May 2026",
  "accepted": false,
  "accepted_at": null,
  "required": true
}
```

### GET `/api/data-room/nda/current`

Requires authorised session. Logs `nda_viewed`.

### POST `/api/data-room/nda/accept`

Request:

```json
{
  "scroll_completed": true,
  "accepted_button_label": "I agree"
}
```

Stores `scroll_completion_required: true`, `acceptance_method: clickwrap`, and the active agreement text hash.

### GET `/api/data-room/documents`

Requires authorised session and accepted current NDA.

Response:

```json
{
  "status": "success",
  "documents": [
    {
      "id": "uuid",
      "filename": "KLPS Deck.pdf",
      "category": "Investor",
      "file_size": "1200000",
      "version": "1.0",
      "uploaded_at": "2026-05-17T10:00:00.000Z",
      "updated_at": "2026-05-17T10:00:00.000Z",
      "access_level": "authorised_user",
      "watermark_required": true,
      "active": true
    }
  ],
  "watermark_text": "Confidential Property of KLPS Ltd"
}
```

### POST `/api/data-room/documents/:id/url`

Request:

```json
{
  "action": "view"
}
```

Response:

```json
{
  "status": "success",
  "action": "view",
  "signed_url": "https://api.klps.co.uk/api/data-room/documents/.../file?...",
  "expires_at": "2026-05-17T10:05:00.000Z"
}
```

Opening the signed URL logs `document_viewed` or `document_downloaded`.

### POST `/api/data-room/logout`

Revokes the active session and logs `logout`.

## Admin APIs

All admin APIs require `founder_admin`.

- `GET /api/data-room/admin/users`
- `POST /api/data-room/admin/users/authorise`
- `POST /api/data-room/admin/users/revoke`
- `GET /api/data-room/admin/access-logs`
- `GET /api/data-room/admin/nda-acceptances`
- `GET /api/data-room/admin/document-activity`
- `POST /api/data-room/admin/documents`
- `POST /api/data-room/admin/documents/upload-url`
- `PATCH /api/data-room/admin/documents/:id`
- `DELETE /api/data-room/admin/documents/:id`
- `POST /api/data-room/admin/maintenance/cleanup-auth`

Authorise request:

```json
{
  "email": "investor@example.com",
  "access_tier": "investor_nda"
}
```

Create R2 upload URL request:

```json
{
  "filename": "KLPS Deck.pdf",
  "content_type": "application/pdf"
}
```

The response contains a short-lived `upload_url`. The frontend uploads the file bytes directly to R2 with `PUT`, then registers metadata with `POST /api/data-room/admin/documents`.

Register document request:

```json
{
  "filename": "KLPS Deck.pdf",
  "category": "Investor",
  "description": "Current investor deck.",
  "file_size": 1200000,
  "version": "1.0",
  "storage_path": "decks/klps-deck-v1.pdf",
  "storage_provider": "r2",
  "content_type": "application/pdf",
  "sort_order": 10,
  "access_level": "investor_nda",
  "watermark_required": true
}
```

## Security notes

- The client never receives invite codes, authorisation rules, session secrets, OTP hashes, or storage paths.
- Login is rate-limited through `data_room.login_attempts`.
- Sessions are opaque, hashed in the database, expiring, and revocable.
- Revoked users lose access immediately because session validation and signed document URL access both check current user role.
- NDA acceptance is one row per `(user_id, nda_version)`. A new active NDA version forces re-acceptance.
- Document IDs alone do not grant access. The server checks role, document activity, NDA acceptance, and signed URL validity.
- `data_room.access_events` has triggers blocking update/delete to keep logs append-only at the database layer.
- Production rejects non-HTTPS requests after proxy headers are trusted.
- CORS is explicit and supports `FRONTEND_ORIGIN` for the production frontend.
- R2 credentials stay server-side. The frontend receives only short-lived upload URLs and backend-issued document URLs.

## Backups and recovery

Create a data-room-only Postgres export:

```bash
DATABASE_URL=postgres://... npm run backup:data-room
```

Create an encrypted local export:

```bash
DATABASE_URL=postgres://... BACKUP_ENCRYPTION_PASSPHRASE="..." npm run backup:data-room
```

Restore an SQL export:

```bash
DATABASE_URL=postgres://... npm run restore:data-room -- ./backups/klps-data-room.sql
```

Railway's managed database backups should still be enabled. These scripts are the extra founder-controlled recovery path.

## Implementation plan

1. Apply `server/sql/20260517_data_room.sql` to production Postgres.
2. Set production environment variables.
3. Configure Resend with `RESEND_API_KEY` and a verified `EMAIL_FROM`.
4. Configure Cloudflare R2 env vars.
5. Update React to call `/api/data-room/session` on load.
6. Replace localStorage auth with OTP login and cookie credentials.
7. Gate documents behind `/nda/status`, `/nda/current`, and `/nda/accept`.
8. Replace public document links with `/documents/:id/url`.
9. Expose founder-only controls from the `/admin/*` endpoints.
