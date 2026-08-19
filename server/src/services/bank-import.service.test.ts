import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseMonzoCsv,requireBankEnvironment } from "./bank-import.service";

test("bank foundation migration is additive, read-only and environment guarded",()=>{
  const sql=readFileSync("server/sql/20260818_bank_import_foundation.sql","utf8");
  for(const table of ["bank_connections","bank_accounts","bank_sync_runs","bank_transactions"])assert.match(sql,new RegExp(`CREATE TABLE finance_os\\.${table}`));
  assert.match(sql,/provider_environment IN \('sandbox','production'\)/);
  assert.match(sql,/validate_bank_sync_environment/);
  assert.doesNotMatch(sql,/UPDATE finance_os\.expenses|DELETE FROM finance_os\.expenses|TRUNCATE/i);
  assert.match(sql,/encrypted_access_token text/);assert.match(sql,/encrypted_refresh_token text/);
  assert.doesNotMatch(sql,/(?<!encrypted_)access_token text|(?<!encrypted_)refresh_token text|payment_initiation|standing_order/i);
});

test("bank CSV routes are founder-only, multipart, and expose no connection mutation",()=>{
  const routes=readFileSync("server/src/routes/finance.routes.ts","utf8");
  assert.match(routes,/router\.post\("\/bank-imports\/monzo-csv",requireFinanceWrite,bankCsvUpload\.single\("file"\)/);
  assert.match(routes,/router\.get\("\/bank-imports",requireFinanceWrite/);
  assert.match(routes,/router\.get\("\/bank-transactions",requireFinanceWrite/);
  assert.doesNotMatch(routes,/bank-(?:payments|transfers)|payment-initiation|standing-orders/);
  assert.doesNotMatch(routes,/encrypted_access_token|encrypted_refresh_token/);
});

test("bank environments fail closed",()=>{
  assert.equal(requireBankEnvironment("sandbox"),"sandbox");
  assert.equal(requireBankEnvironment("production"),"production");
  for(const value of [undefined,null,"","live","test"])assert.throws(()=>requireBankEnvironment(value),/explicitly sandbox or production/);
});

test("Monzo CSV parser preserves quoted fields, stable IDs, signs and provenance",()=>{
  const csv=Buffer.from('\uFEFFTransaction ID,Date,Time,Type,Name,Category,Amount,Currency,Notes and #tags,Description\n"tx_1",18/08/2026,12:30:01,Card,"Shop, Ltd",General,-12.34,GBP,"note, tagged",Purchase\n,2026-08-17,10:00:00,Bank transfer,Customer,Income,50.00,GBP,Reference,Receipt\n');
  const rows=parseMonzoCsv(csv);
  assert.equal(rows.length,2);assert.equal(rows[0].sourceRecordId,"tx_1");assert.equal(rows[0].merchantName,"Shop, Ltd");assert.equal(rows[0].direction,"debit");assert.equal(rows[0].bookingDate,"2026-08-18");
  assert.match(rows[1].sourceRecordId,/^csv_[0-9a-f]{64}$/);assert.equal(rows[1].direction,"credit");assert.equal(rows[1].occurredAt,null,"timezone-less statement times must not be invented as UTC");
});

test("Monzo CSV rejects missing columns, zero amounts and duplicate source identities",()=>{
  assert.throws(()=>parseMonzoCsv(Buffer.from("Date,Amount\n18/08/2026,-1\n")),/requires Date, Amount and Currency/);
  assert.throws(()=>parseMonzoCsv(Buffer.from("Date,Amount,Currency\n18/08/2026,0,GBP\n")),/Invalid Monzo transaction amount/);
  assert.throws(()=>parseMonzoCsv(Buffer.from("Transaction ID,Date,Amount,Currency\ntx,18/08/2026,-1,GBP\ntx,18/08/2026,-1,GBP\n")),/Duplicate transaction identity/);
});
