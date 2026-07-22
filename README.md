# KLPS Core

KLPS Core is the canonical backend platform for the entire KLPS product ecosystem. It began as LEMA—the Learning Engine for Modular Intelligence—but its mandate is now much broader than an Express API or a single AI service.

This repository owns—or is the designated home for—the shared data, business rules, security boundaries, audit history, storage integration, intelligence orchestration, and APIs used by every KLPS client.

```text
                         KLPS Core
                             │
             ┌───────────┬───┴───┬───────────┐
             │           │       │           │
         Finance OS  Data Room   AI       Evidence
```

```text
Shared platform responsibilities
├── PostgreSQL system of record
├── Authentication and user management
├── Canonical Company and Product entities
├── Cloudflare R2 private-object storage
├── AI orchestration and persistent intelligence
├── Internal, public and partner APIs
└── Website and mobile application backend
```

KLPS Core serves the KLPS website and internal tools and is the backend foundation for future APIs and mobile applications. Domain logic must live here rather than being duplicated across clients.

## Platform mandate

| Domain | KLPS Core responsibility |
| --- | --- |
| Finance OS | Financial assumptions, scenarios, products, funding, decisions, risks, models, reports and audit events |
| Data Room | Documents, NDA enforcement, access tiers, permissions, user administration and access auditing |
| Evidence | Canonical evidence metadata, verification, lifecycle, versioning, entity relationships and private file references |
| R2 | Private object storage integration, object keys, uploads and short-lived authorised access |
| Identity | Authentication, sessions, users, roles, founder/admin controls and future client identity |
| Company | One canonical Company entity and its relationships; never duplicated inside feature domains |
| Products | Canonical product records shared by Finance OS and future operational workflows |
| AI | Governed orchestration, research processing, structured signals, summaries, learning and persistent intelligence |
| APIs | Existing internal APIs plus future stable public, partner and mobile contracts |
| Mobile | Authentication, data, business rules and workflows for future KLPS mobile applications |

Some mandate areas are already implemented and others are being built. Their canonical backend ownership is settled here even when their final APIs do not yet exist.

## Current implementation

### Available today

- **Finance OS** — scenarios, assumptions, evidence, products, planned hires, funding, decisions, risks, model snapshots, reports, immutable finance events, and recalculation services.
- **Investor Data Room** — authenticated document access, NDA acceptance, permissions, access tiers, audit events, document administration, and controlled download flows.
- **Canonical Evidence** — UUID-backed evidence records, human-readable evidence codes, controlled metadata, verification and document lifecycle states, review dates, version history, filters, and links to supported Finance OS entities.
- **Cloudflare R2 integration** — private-object upload and short-lived presigned access for Data Room content. Object keys are stored internally; public object URLs are not part of the evidence contract.
- **Authentication and user access** — email OTP login, server-side sessions, founder/admin controls, authorised, pending and revoked user states, NDA gates, and access tiers.
- **AI and learning workflows** — structured questions, signals, summaries, patterns, founder insights, research processing, and persistent learning data.
- **Operational APIs** — waitlist, founder analytics, health checks and database readiness checks.
- **PostgreSQL system of record** — separate `data_room`, `finance_os`, research, and learning domains with constraints, audit metadata and safe migrations.

### In development and planned

The architecture is being extended to own:

- a canonical Company entity and company-level relationships;
- broader product and portfolio management;
- governed AI orchestration across model providers;
- stable public and partner API contracts;
- mobile application authentication, data and workflows;
- future KPI records and evidence relationships;
- shared notifications and background processing where required.

Items in this section describe planned platform ownership, not necessarily completed API surfaces. New clients should consume KLPS Core rather than recreate these domains locally.

## Core principles

- PostgreSQL UUIDs are canonical internal identifiers.
- Human-readable codes are display and operational references, not primary keys.
- Domain records are linked rather than copied between subsystems.
- Financial and evidence changes retain version and audit history.
- Data Room reads respect authentication, authorisation, NDA and document access controls.
- Founder/admin permissions protect administrative and Finance OS writes.
- R2 objects remain private and are accessed through short-lived backend-authorised flows.
- Evidence metadata is distinct from file upload and storage transport.
- AI output should remain traceable to structured inputs and persisted system state.
- Website and mobile clients are presentation layers; canonical business rules belong here.

## Repository map

```text
server/
├── sql/                 Ordered PostgreSQL migrations
├── docs/                Backend and integration documentation
└── src/
    ├── api/             Signal and question APIs
    ├── config/          Runtime and database configuration
    ├── middleware/      Request authentication boundaries
    ├── routes/          Finance, Data Room, research and platform APIs
    ├── services/        Domain logic and external integrations
    ├── storage/         PostgreSQL client
    └── index.ts         Express composition and runtime entry point
scripts/                 Data Room backup and restore operations
```

## Main API domains

| Prefix | Responsibility |
| --- | --- |
| `/api/finance` | Finance OS state, models, assumptions, evidence, decisions, risks, funding, reports and events |
| `/api/data-room` | Login, sessions, NDA, users, documents, permissions and access audit |
| `/api/research` | Research capture, processing and metrics |
| `/api/questions` | Structured question workflows |
| `/api/summary` | Daily summaries, patterns and derived learning views |
| `/api/session` | Learning-session lifecycle |
| `/api/founder` | Founder-only operational analytics |
| `/api/waitlist` | Waitlist registration and administration |
| `/api/auth/me` | Current authenticated Data Room identity and NDA state |
| `/health`, `/ready` | Process health and PostgreSQL readiness |

Not every route has the same audience. Data Room and Finance APIs apply their existing authentication, NDA and role middleware; callers must not infer access from route visibility alone.

## Canonical Evidence contract

Evidence is stored in `finance_os.evidence` with an internal UUID primary key and a unique database-generated code such as `EVD-0001`. Canonical metadata includes:

- title, description and controlled evidence type;
- document category, source organisation, owner and confidence;
- verification status and document status;
- review frequency and review/expiry dates;
- private R2 object key, original filename, MIME type and file size;
- checksum, file version and folder path;
- created/updated users, timestamps, version and change reason.

Evidence can currently be linked to existing Finance OS assumptions, products, decisions, risks, funding records, reports, scenarios, hires and documents. Company and KPI link types are reserved until their canonical tables exist; KLPS Core does not create duplicate company configuration or fabricated evidence to fill those gaps.

Evidence endpoints support list/filter, detail, create, update, link, unlink, linked-entity retrieval and immutable version history. Reads require an authenticated, authorised user with the current NDA accepted. Writes additionally require `founder_admin`.

## Technology

- Node.js and TypeScript
- Express
- PostgreSQL via `pg`
- Cloudflare R2 through the AWS S3-compatible SDK
- Resend for authentication email delivery
- Node's built-in test runner

## Local development

Requirements:

- a supported Node.js release;
- PostgreSQL reachable through `DATABASE_URL`;
- npm.

Install and verify:

```bash
npm install
npm run build
npm test
npm run dev
```

The server listens on `PORT`, defaulting to `5001`.

### Environment configuration

Core:

```dotenv
DATABASE_URL=postgresql://...
PORT=5001
NODE_ENV=development
FRONTEND_ORIGINS=http://localhost:8080
DATA_ROOM_SECRET=replace-with-a-strong-secret
```

Email authentication:

```dotenv
RESEND_API_KEY=...
EMAIL_FROM=...
```

Cloudflare R2:

```dotenv
CLOUDFLARE_R2_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET=...
# Optional override:
CLOUDFLARE_R2_ENDPOINT=...
```

Additional session, OTP, signed-URL, local-storage and research-upload limits can be configured through the environment variables referenced in `server/src`.

Never commit secrets or expose R2 credentials or private object URLs to a client.

## Database migrations

SQL migrations live in `server/sql` and are ordered by date. Apply them in filename order to the intended PostgreSQL environment:

```text
20260517_data_room.sql
20260519_data_room_robustness.sql
20260608_research_data_integrity.sql
20260702_waitlist_signups.sql
20260707_finance_os.sql
20260721_canonical_evidence.sql
```

Review migrations before applying them, take a backup for production changes, and never replace canonical records with seed or fabricated evidence.

## Quality checks

```bash
npm run build   # TypeScript compilation
npm test        # Backend service tests
```

Changes to authentication, access control, financial calculations, evidence links, migrations or storage boundaries should include proportionate tests.

## Boundary for client applications

The KLPS website and future mobile applications should:

- use backend UUIDs for relationships and human-readable codes for display;
- rely on KLPS Core for access decisions and domain validation;
- send private R2 object keys only through authorised contracts;
- avoid embedding Finance OS, Evidence, Company or Data Room business rules in UI code;
- treat API responses as the canonical system state.

KLPS Core is the operational and intelligence foundation beneath the KLPS product family—not a frontend repository and no longer only the LEMA AI engine.
