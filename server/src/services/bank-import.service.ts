import crypto from "crypto";
import path from "path";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db=Pick<PoolClient,"query">;
type BankEnvironment="sandbox"|"production";
type CsvRow=Record<string,string>;
type MonzoTransaction={sourceRecordId:string;providerTransactionId:string|null;bookingDate:string;occurredAt:string|null;amount:string;currency:string;direction:"credit"|"debit";merchantName:string|null;reference:string|null;description:string|null;providerCategory:string|null;providerCode:string|null;metadata:Record<string,string>};

const bankError=(message:string,code:string,statusCode=400,details?:unknown)=>Object.assign(new Error(message),{code,statusCode,details});
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const sha256=(value:Buffer|string)=>crypto.createHash("sha256").update(value).digest("hex");

export const requireBankEnvironment=(value:unknown):BankEnvironment=>{
  if(value==="sandbox"||value==="production")return value;
  throw bankError("provider_environment must be explicitly sandbox or production","bank_environment_required");
};

export const parseCsv=(input:string):string[][]=>{
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false;
  for(let i=0;i<input.length;i++){
    const char=input[i];
    if(quoted){
      if(char==='"'&&input[i+1]==='"'){field+='"';i++;}
      else if(char==='"')quoted=false;
      else field+=char;
    }else if(char==='"')quoted=true;
    else if(char===","){row.push(field);field="";}
    else if(char==="\n"){row.push(field.replace(/\r$/, ""));rows.push(row);row=[];field="";}
    else field+=char;
  }
  if(quoted)throw bankError("CSV contains an unterminated quoted value","invalid_bank_csv");
  if(field||row.length){row.push(field.replace(/\r$/, ""));rows.push(row);}
  return rows.filter(values=>values.some(value=>value.trim()));
};

const canonicalHeader=(value:string)=>value.replace(/^\uFEFF/,"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
const pick=(row:CsvRow,...names:string[])=>names.map(name=>row[name]).find(value=>clean(value))??"";
const isoDate=(value:string)=>{
  const source=clean(value);let year="",month="",day="";
  let match=source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(match)[,year,month,day]=match;
  else{match=source.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);if(match)[,day,month,year]=match;}
  if(!year)throw bankError(`Invalid Monzo transaction date: ${source||"missing"}`,"invalid_bank_csv_date");
  const result=`${year}-${month}-${day}`;
  if(new Date(`${result}T00:00:00Z`).toISOString().slice(0,10)!==result)throw bankError(`Invalid Monzo transaction date: ${source}`,"invalid_bank_csv_date");
  return result;
};
const decimal=(value:string)=>{
  const normalized=clean(value).replace(/,/g,"");
  if(!/^-?\d+(?:\.\d{1,8})?$/.test(normalized)||Number(normalized)===0)throw bankError(`Invalid Monzo transaction amount: ${value}`,"invalid_bank_csv_amount");
  return normalized;
};
const explicitTimestamp=(date:string,time:string)=>{
  const source=clean(time);
  if(!source)return null;
  const complete=source.match(/^\d{4}-\d{2}-\d{2}T/)?source:`${date}T${source}`;
  if(!/(?:Z|[+-]\d{2}:?\d{2})$/.test(complete))return null;
  const parsed=new Date(complete);return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
};

export const parseMonzoCsv=(buffer:Buffer):MonzoTransaction[]=>{
  const matrix=parseCsv(buffer.toString("utf8"));
  if(matrix.length<2)throw bankError("Monzo CSV must contain a header and at least one transaction","invalid_bank_csv");
  const headers=matrix[0].map(canonicalHeader);
  if(!headers.includes("date")||!headers.includes("amount")||!headers.includes("currency"))throw bankError("Monzo CSV requires Date, Amount and Currency columns","invalid_bank_csv_headers");
  const transactions=matrix.slice(1).map((values,index)=>{
    const row=Object.fromEntries(headers.map((header,column)=>[header,values[column]??""])) as CsvRow;
    const bookingDate=isoDate(pick(row,"date","created_date"));
    const amount=decimal(pick(row,"amount","amount_gbp"));
    const currency=clean(pick(row,"currency")).toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))throw bankError(`Invalid currency on Monzo CSV row ${index+2}`,"invalid_bank_csv_currency");
    const providerId=clean(pick(row,"transaction_id","id"))||null;
    const stablePayload=[bookingDate,pick(row,"time"),amount,currency,pick(row,"type"),pick(row,"name","description"),pick(row,"notes_and_tags","notes")].join("|");
    const sourceRecordId=providerId??`csv_${sha256(stablePayload)}`;
    const name=clean(pick(row,"name","merchant","payee"))||null;
    const description=clean(pick(row,"description"))||name;
    return{sourceRecordId,providerTransactionId:providerId,bookingDate,occurredAt:explicitTimestamp(bookingDate,pick(row,"time","timestamp")),amount,currency,direction:Number(amount)<0?"debit" as const:"credit" as const,merchantName:name,reference:clean(pick(row,"notes_and_tags","notes","reference"))||null,description,providerCategory:clean(pick(row,"category"))||null,providerCode:clean(pick(row,"type"))||null,metadata:{source_date:pick(row,"date"),source_time:pick(row,"time","timestamp"),local_amount:pick(row,"local_amount"),local_currency:pick(row,"local_currency"),address:pick(row,"address")}};
  });
  const seen=new Set<string>();
  for(const transaction of transactions){if(seen.has(transaction.sourceRecordId))throw bankError(`Duplicate transaction identity in CSV: ${transaction.sourceRecordId}`,"duplicate_bank_csv_identity");seen.add(transaction.sourceRecordId);}
  return transactions;
};

export type ImportMonzoCsvInput={file:Buffer;filename:string;providerEnvironment:unknown;accountLabel:unknown};
export const importMonzoCsv=async(input:ImportMonzoCsvInput,userId:string,dbPool=pool)=>{
  const environment=requireBankEnvironment(input.providerEnvironment);
  const accountLabel=clean(input.accountLabel);
  if(!accountLabel)throw bankError("account_label is required","bank_account_label_required");
  if(!input.file?.length)throw bankError("A Monzo CSV file is required","bank_csv_required");
  if(input.file.length>5*1024*1024)throw bankError("Monzo CSV exceeds the 5 MB limit","bank_csv_too_large",413);
  const transactions=parseMonzoCsv(input.file),checksum=sha256(input.file),safeFilename=path.basename(input.filename||"monzo.csv").slice(0,255);
  const connectionReference=`monzo-csv-${sha256(accountLabel.toLowerCase()).slice(0,24)}`;
  const client=await dbPool.connect();
  try{
    await client.query("BEGIN");
    const connection=(await client.query(`INSERT INTO finance_os.bank_connections(provider,provider_environment,provider_connection_id,status,granted_scopes,metadata,created_by,updated_by,change_reason) VALUES('monzo_csv',$1,$2,'active','{}',$3::jsonb,$4,$4,'Created by local Monzo CSV import') ON CONFLICT(provider,provider_environment,provider_connection_id) DO UPDATE SET updated_at=now(),updated_by=EXCLUDED.updated_by,change_reason='Reused by local Monzo CSV import' RETURNING id,provider,provider_environment,status`,[environment,connectionReference,JSON.stringify({read_only:true,source:"manual_statement"}),userId])).rows[0];
    const accountReference=`csv-account-${sha256(accountLabel.toLowerCase()).slice(0,24)}`;
    const account=(await client.query(`INSERT INTO finance_os.bank_accounts(connection_id,provider_account_id,display_name,account_type,currency,metadata,created_by,updated_by) VALUES($1,$2,$3,'business_transaction','GBP',$4::jsonb,$5,$5) ON CONFLICT(connection_id,provider_account_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=now(),updated_by=EXCLUDED.updated_by RETURNING id,display_name,currency`,[connection.id,accountReference,accountLabel,JSON.stringify({read_only:true}),userId])).rows[0];
    const prior=(await client.query(`SELECT id,status,fetched_count,inserted_count,updated_count,skipped_count,conflict_count FROM finance_os.bank_sync_runs WHERE connection_id=$1 AND source_checksum=$2`,[connection.id,checksum])).rows[0];
    if(prior){await client.query("ROLLBACK");return{duplicate_file:true,connection,account,sync_run:prior,transactions:[]};}
    const run=(await client.query(`INSERT INTO finance_os.bank_sync_runs(connection_id,bank_account_id,provider_environment,trigger_type,status,source_filename,source_checksum,fetched_count,created_by) VALUES($1,$2,$3,'manual_csv','running',$4,$5,$6,$7) RETURNING id,status,started_at`,[connection.id,account.id,environment,safeFilename,checksum,transactions.length,userId])).rows[0];
    let inserted=0,updated=0;
    for(const transaction of transactions){
      const result=await client.query(`INSERT INTO finance_os.bank_transactions(bank_account_id,first_sync_run_id,last_sync_run_id,source_record_id,provider_transaction_id,status,occurred_at,booked_at,booking_date,value_date,amount,currency,direction,merchant_name,counterparty_name,reference,description,provider_category,provider_code,provider_metadata) VALUES($1,$2,$2,$3,$4,'booked',$5,$5,$6,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(bank_account_id,source_record_id) DO UPDATE SET last_sync_run_id=EXCLUDED.last_sync_run_id,provider_transaction_id=EXCLUDED.provider_transaction_id,status=EXCLUDED.status,occurred_at=EXCLUDED.occurred_at,booked_at=EXCLUDED.booked_at,booking_date=EXCLUDED.booking_date,value_date=EXCLUDED.value_date,amount=EXCLUDED.amount,currency=EXCLUDED.currency,direction=EXCLUDED.direction,merchant_name=EXCLUDED.merchant_name,counterparty_name=EXCLUDED.counterparty_name,reference=EXCLUDED.reference,description=EXCLUDED.description,provider_category=EXCLUDED.provider_category,provider_code=EXCLUDED.provider_code,provider_metadata=EXCLUDED.provider_metadata,provider_updated_at=now(),updated_at=now() RETURNING (xmax=0) AS inserted,id`,[account.id,run.id,transaction.sourceRecordId,transaction.providerTransactionId,transaction.occurredAt,transaction.bookingDate,transaction.amount,transaction.currency,transaction.direction,transaction.merchantName,transaction.reference,transaction.description,transaction.providerCategory,transaction.providerCode,JSON.stringify(transaction.metadata)]);
      if(result.rows[0].inserted)inserted++;else updated++;
    }
    const completed=(await client.query(`UPDATE finance_os.bank_sync_runs SET status='succeeded',inserted_count=$1,updated_count=$2,skipped_count=$3,finished_at=now() WHERE id=$4 RETURNING id,status,fetched_count,inserted_count,updated_count,skipped_count,conflict_count,started_at,finished_at`,[inserted,updated,transactions.length-inserted-updated,run.id])).rows[0];
    await client.query(`UPDATE finance_os.bank_connections SET last_successful_sync_at=now(),updated_at=now(),updated_by=$1,change_reason='Completed local Monzo CSV import' WHERE id=$2`,[userId,connection.id]);
    await client.query("COMMIT");
    return{duplicate_file:false,connection,account,sync_run:completed,transactions:transactions.map(transaction=>({source_record_id:transaction.sourceRecordId,booking_date:transaction.bookingDate,amount:transaction.amount,currency:transaction.currency,direction:transaction.direction,merchant_name:transaction.merchantName,status:"booked",reconciliation_status:"unmatched"}))};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
};

export const listBankImports=async(db:Db=pool)=>(await db.query(`SELECT r.id,r.provider_environment,r.status,r.source_filename,r.source_checksum,r.fetched_count,r.inserted_count,r.updated_count,r.skipped_count,r.conflict_count,r.started_at,r.finished_at,c.provider,a.display_name account_label FROM finance_os.bank_sync_runs r JOIN finance_os.bank_connections c ON c.id=r.connection_id LEFT JOIN finance_os.bank_accounts a ON a.id=r.bank_account_id WHERE r.trigger_type='manual_csv' ORDER BY r.started_at DESC LIMIT 100`)).rows;
export const listBankTransactions=async(db:Db=pool)=>(await db.query(`SELECT t.id,t.source_record_id,t.provider_transaction_id,t.status,t.occurred_at,t.booking_date::text booking_date,t.value_date::text value_date,t.amount,t.currency,t.direction,t.merchant_name,t.counterparty_name,t.reference,t.description,t.provider_category,t.imported_at,t.reconciliation_status,t.expense_id,a.display_name account_label,c.provider,c.provider_environment FROM finance_os.bank_transactions t JOIN finance_os.bank_accounts a ON a.id=t.bank_account_id JOIN finance_os.bank_connections c ON c.id=a.connection_id ORDER BY t.booking_date DESC,t.created_at DESC LIMIT 500`)).rows;
