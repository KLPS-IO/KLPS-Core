# Frontend Prompt: KLPS Data Room Robustness Update

Please update the KLPS Innovation Lab / Investor Data Room UI to use the new backend capabilities.

Backend base:

```text
API_BASE=https://klps-lema-production.up.railway.app
```

Use `credentials: "include"` for every request.

## Session and roles

Session endpoints:

- `GET /api/data-room/session`
- `GET /api/data-room/me`
- `GET /api/data-room/auth/me`

The session response now includes:

```json
{
  "authenticated": true,
  "user": {
    "id": "uuid",
    "email": "emmamendez07@gmail.com",
    "role": "founder_admin",
    "access_tier": "admin_only",
    "is_admin": true
  }
}
```

Do not grant founder/admin access from typed email. Only use the backend session response after OTP verification.

## Access tiers

Use these access tiers in admin UI:

- `public_light`
- `investor_nda`
- `advisor_nda`
- `founder_only`
- `legal_only`
- `admin_only`

Founder/admin can assign an authorised user an `access_tier`.

Authorise user:

```http
POST /api/data-room/admin/users/authorise
```

```json
{
  "email": "investor@example.com",
  "access_tier": "investor_nda"
}
```

## Categories

Add a room navigation/sidebar or grouped document display from:

```http
GET /api/data-room/categories
```

Default sections:

- `01 Company Overview`
- `02 Pitch Deck`
- `03 Product and Technology`
- `04 IP and Defensibility`
- `05 Market and Customers`
- `06 Financials`
- `07 Validation and Programmes`
- `08 Brand Assets`
- `09 Legal and Compliance`
- `10 Founder Only`

Only show categories returned by the backend.

## Documents

Document list:

```http
GET /api/data-room/documents
```

Documents now include:

```json
{
  "id": "uuid",
  "filename": "KLPS Deck.pdf",
  "category": "02_pitch_deck",
  "description": "Current investor deck.",
  "file_size": "1200000",
  "version": "1.0",
  "storage_provider": "r2",
  "content_type": "application/pdf",
  "sort_order": 10,
  "access_level": "investor_nda",
  "watermark_required": true
}
```

Open/download:

```http
POST /api/data-room/documents/:id/url
```

```json
{
  "action": "view"
}
```

Open the returned `signed_url`. Do not construct Cloudflare R2 URLs in the frontend.

## Admin R2 upload flow

Add an admin-only document upload UI.

Step 1: ask backend for an upload URL:

```http
POST /api/data-room/admin/documents/upload-url
```

```json
{
  "filename": "KLPS Deck.pdf",
  "content_type": "application/pdf"
}
```

Step 2: upload the file bytes to the returned `upload_url` with:

```text
PUT upload_url
Content-Type: the returned headers["content-type"]
```

Step 3: register document metadata:

```http
POST /api/data-room/admin/documents
```

```json
{
  "filename": "KLPS Deck.pdf",
  "category": "02_pitch_deck",
  "description": "Current investor deck.",
  "file_size": 1200000,
  "version": "1.0",
  "storage_path": "value returned by upload-url",
  "storage_provider": "r2",
  "content_type": "application/pdf",
  "sort_order": 10,
  "access_level": "investor_nda",
  "watermark_required": true
}
```

Founder/admin should also be able to patch metadata and deactivate documents:

- `PATCH /api/data-room/admin/documents/:id`
- `DELETE /api/data-room/admin/documents/:id`

## UI guidance

- Show access tier labels in admin user management.
- Show document access level labels in admin document management.
- Make founder-only/legal/admin-only docs visually distinct in admin views.
- Non-admin users should never see founder-only sections unless the backend returns them.
- Keep the “Return to Innovation Lab” button near the login/data-room entry view.
- Keep watermark text visible where documents are listed: `Confidential Property of KLPS Ltd`.
