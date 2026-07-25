# Future read-only transaction import layer

This is an architecture note only. No bank or payment integration is implemented.

- Starling is the primary company-bank transaction source.
- PayPal is an optional secondary transaction source.
- Provider transaction IDs form an idempotency key with the provider account ID.
- Immutable raw provider payloads are stored separately from canonical Finance OS expenses.
- Imported transactions have an explicit reconciliation status such as Unmatched, Suggested Match, Matched, Ignored or Needs Review.
- A founder/admin must manually approve creating an expense or matching a transaction to an existing expense.
- The import layer is read-only and requests no payment permissions.
- Imported data never automatically overwrites canonical expense records.
- Reconciliation retains the imported transaction, approval actor, timestamp and match history for auditability.
