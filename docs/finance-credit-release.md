# Finance OS banking and credit facilities

Cash authority is computed by the backend. Available credit and planned funding are never actual cash; unknown is distinct from evidenced zero. Portal observations are timestamped account evidence, not contracts or statements. Payment-date display text without a year remains text; the payment amount remains unknown without separate evidence.

## Production release

Inspect production schema read-only first. Apply only absent migrations, in this dependency order: `20260818_bank_import_foundation.sql`, `20260918_credit_facilities.sql`, `20260918_credit_integrity.sql`. Test against a local restore before applying. Do not execute rollback scripts against populated production. Preserve unrelated company, funding, expenses, VAT and accounting data.

Contract and screenshot ingestion uses canonical evidence upload, checksum deduplication, private object storage and founder-only links. Original files and operator manifests stay outside Git. Never populate production from a synthetic test database. Preserve document/page/clause provenance and capture-time semantics. A screenshot does not establish a statement, monetary minimum payment, applied interest rate or cleared repayment history.

`FINANCE_LOCAL_REVIEW` and `FINANCE_LOCAL_EVIDENCE_ROOT` are local-test transport options only and must not be enabled in production. Bank imports stage records and cannot automatically create expense/VAT/accounting treatment. Scenario calculation or saving cannot issue a financial instruction.

## Deferred Capital on Tap transaction adapter

When the first genuine KLPS Capital on Tap transaction has cleared, export Standard CSV from Capital on Tap and use that real provider file to design and validate the Capital on Tap transaction adapter.

Capital on Tap exports transactions by clearance date, which may differ from transaction date.

Do not design the provider parser before obtaining the real export.
