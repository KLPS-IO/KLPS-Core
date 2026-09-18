import type {} from 'multer';
import {createUploadedEvidenceRecord,parseDocumentUploadInput,buildDocumentStorage,finishUploadedEvidenceRecord,findActiveEvidenceByChecksum} from './document-upload.service';
import {linkEvidence} from './evidence.service';
import { uploadToR2, deleteFromR2 } from './r2.service';
import { logFinanceEvent } from './finance-engine.service';
import { decimal } from './finance-decimal';
import type { BankImportAdapter } from './bank-adapter';
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
const csvDecimal=(value:string)=>{
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
  if(matrix.length<1)throw bankError("Monzo CSV must contain a header","invalid_bank_csv");
  const headers=matrix[0].map(canonicalHeader);
  if(!headers.includes("date")||!headers.includes("amount")||!headers.includes("currency"))throw bankError("Monzo CSV requires Date, Amount and Currency columns","invalid_bank_csv_headers");
  if(new Set(headers).size!==headers.length)throw bankError("Duplicate CSV headers","invalid_bank_csv_headers");
  const occurrence=new Map<string,number>();
  const transactions=matrix.slice(1).map((values,index)=>{
    if(values.length!==headers.length)throw bankError("CSV row width differs from headers","invalid_bank_csv");
    const row=Object.fromEntries(headers.map((header,column)=>[header,values[column]??""])) as CsvRow;
    const bookingDate=isoDate(pick(row,"date","created_date"));
    const amount=csvDecimal(pick(row,"amount","amount_gbp"));
    const currency=clean(pick(row,"currency")).toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))throw bankError(`Invalid currency on Monzo CSV row ${index+2}`,"invalid_bank_csv_currency");
    const providerId=clean(pick(row,"transaction_id","id"))||null;
    const stablePayload=[bookingDate,pick(row,"time"),amount,currency,pick(row,"type"),pick(row,"name","description"),pick(row,"notes_and_tags","notes")].join("|");
    const signature=sha256(stablePayload);const ordinal=(occurrence.get(signature)??0)+1;occurrence.set(signature,ordinal);
    const sourceRecordId=providerId??`csv_${sha256(buffer)}_${signature}_${ordinal}`;
    const name=clean(pick(row,"name","merchant","payee"))||null;
    const description=clean(pick(row,"description"))||name;
    return{sourceRecordId,providerTransactionId:providerId,bookingDate,occurredAt:explicitTimestamp(bookingDate,pick(row,"time","timestamp")),amount,currency,direction:Number(amount)<0?"debit" as const:"credit" as const,merchantName:name,reference:clean(pick(row,"notes_and_tags","notes","reference"))||null,description,providerCategory:clean(pick(row,"category"))||null,providerCode:clean(pick(row,"type"))||null,metadata:{identity_basis:providerId?"provider_id":"file_row",row_number:String(index+2),source_signature:signature,source_date:pick(row,"date"),source_time:pick(row,"time","timestamp"),local_amount:pick(row,"local_amount"),local_currency:pick(row,"local_currency"),address:pick(row,"address")}};
  });
  const seen=new Set<string>();
  for(const transaction of transactions){if(seen.has(transaction.sourceRecordId))throw bankError(`Duplicate transaction identity in CSV: ${transaction.sourceRecordId}`,"duplicate_bank_csv_identity");seen.add(transaction.sourceRecordId);}
  return transactions;
};

export const monzoAdapter:BankImportAdapter={provider:'monzo_csv',version:'monzo-csv-v2',parse:parseMonzoCsv};
export type ImportMonzoCsvInput={file:Buffer;filename:string;providerEnvironment:unknown;accountLabel:unknown;accountId?:unknown;stableAccountKey?:unknown};
export const importMonzoCsv=async(input:ImportMonzoCsvInput,userId:string,dbPool=pool)=>{
 const environment=requireBankEnvironment(input.providerEnvironment),label=clean(input.accountLabel),accountId=clean(input.accountId),stableKey=clean(input.stableAccountKey);
 if(!accountId&&!stableKey)throw bankError('Select a stable account ID or provide a persistent account key (not its display label)','stable_account_required');
 if(!input.file?.length||input.file.length>5*1024*1024)throw bankError('CSV must be between 1 byte and 5 MB','invalid_bank_csv');
 const checksum=sha256(input.file),client=await dbPool.connect();let runId:string|undefined;let newObjectKey:string|undefined;
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`monzo:${environment}:${accountId||stableKey}`]);
  let account:Record<string,any>,connection:Record<string,any>;
  if(accountId){
   account=(await client.query(`SELECT a.* FROM finance_os.bank_accounts a JOIN finance_os.bank_connections c ON c.id=a.connection_id WHERE a.id=$1 AND c.provider='monzo_csv' AND c.provider_environment=$2 FOR UPDATE`,[accountId,environment])).rows[0];
   if(!account)throw bankError('Account is not a Monzo account in this environment','invalid_bank_account');
   connection=(await client.query('SELECT id,provider,provider_environment FROM finance_os.bank_connections WHERE id=$1',[account.connection_id])).rows[0];
  }else{
   if(!label||stableKey.length<4||stableKey.length>120)throw bankError('Account label and persistent key (4–120 characters) required','invalid_bank_account');
   const identity=`monzo:${environment}:${sha256(stableKey)}`;
   connection=(await client.query(`INSERT INTO finance_os.bank_connections(provider,provider_environment,provider_connection_id,metadata,created_by,updated_by,change_reason) VALUES('monzo_csv',$1,$2,'{"read_only":true}',$3,$3,'Founder selected stable manual account key') ON CONFLICT(provider,provider_environment,provider_connection_id) DO UPDATE SET updated_at=now() RETURNING id,provider,provider_environment`,[environment,identity,userId])).rows[0];
   account=(await client.query(`INSERT INTO finance_os.bank_accounts(connection_id,provider_account_id,display_name,account_type,currency,stable_import_key,created_by,updated_by) VALUES($1,$2,$3,'business_transaction','GBP',$2,$4,$4) ON CONFLICT(stable_import_key) DO UPDATE SET display_name=EXCLUDED.display_name,updated_by=EXCLUDED.updated_by RETURNING *`,[connection.id,identity,label,userId])).rows[0];
  }
  const prior=(await client.query(`SELECT * FROM finance_os.bank_sync_runs WHERE connection_id=$1 AND source_checksum=$2`,[connection.id,checksum])).rows[0];
  if(prior&&prior.status!=='failed'){await client.query('ROLLBACK');return {duplicate_file:true,connection,account,sync_run:prior,transactions:[]};}
  if(prior){runId=prior.id;await client.query("UPDATE finance_os.bank_sync_runs SET status='running',error_code=NULL,finished_at=NULL WHERE id=$1",[runId]);await logFinanceEvent({eventType:'bank.import.retried',entityType:'bank_sync_run',entityId:runId,summary:'Explicit retry of failed import; prior failure event retained',userId,client});}
  else runId=(await client.query(`INSERT INTO finance_os.bank_sync_runs(connection_id,bank_account_id,provider_environment,trigger_type,status,source_filename,source_checksum,adapter_version,created_by) VALUES($1,$2,$3,'manual_csv','running',$4,$5,$6,$7) RETURNING id`,[connection.id,account.id,environment,path.basename(input.filename),checksum,monzoAdapter.version,userId])).rows[0].id;
  await client.query('COMMIT');
  // Keep the attempt durable even if parsing or canonical staging fails.
  const transactions=monzoAdapter.parse(input.file);
  if(transactions.some(t=>t.currency!==account.currency))throw bankError('Account currency does not match CSV settlement currency','currency_mismatch');
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[account.id]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[checksum]);
  let evidence=await findActiveEvidenceByChecksum(checksum,client);
  if(!evidence){
   const docInput=parseDocumentUploadInput({title:'Monzo transaction import',document_category:'Finance',source_organisation:'Monzo',document_date:new Date().toISOString().slice(0,10)});
   evidence=await createUploadedEvidenceRecord(docInput,{buffer:input.file,originalname:path.basename(input.filename),mimetype:'text/csv',size:input.file.length} as Express.Multer.File,userId,client);
   const storage=buildDocumentStorage('Finance',evidence.evidence_code,'Monzo transaction import',docInput.documentDate,input.filename);
   await uploadToR2(storage.objectKey,input.file,'text/csv');newObjectKey=storage.objectKey;evidence=await finishUploadedEvidenceRecord(evidence.id,storage.objectKey,client);
  }
  await client.query('UPDATE finance_os.evidence SET founder_only=true WHERE id=$1',[evidence.id]);
  let inserted=0,skipped=0,conflicts=0;
  for(const t of transactions){
   const old=(await client.query('SELECT * FROM finance_os.bank_transactions WHERE bank_account_id=$1 AND source_record_id=$2 FOR UPDATE',[account.id,t.sourceRecordId])).rows[0];
   if(old){
    const same=decimal(String(old.amount))===decimal(t.amount)&&old.currency===t.currency&&String(old.booking_date instanceof Date?old.booking_date.toISOString().slice(0,10):old.booking_date)===t.bookingDate&&old.description===t.description;
    if(same){skipped++;continue;}
    await client.query(`UPDATE finance_os.bank_transactions SET reconciliation_status='conflict',conflict_payload=$2,updated_at=now(),last_sync_run_id=$3 WHERE id=$1`,[old.id,JSON.stringify({incoming:t,evidence_id:evidence.id,previous:{amount:old.amount,currency:old.currency,description:old.description,source_evidence_id:old.source_evidence_id},reason:'Changed source facts require founder review'}),runId]);conflicts++;continue;
   }
   const ambiguous=!t.providerTransactionId&&(await client.query(`SELECT id FROM finance_os.bank_transactions WHERE bank_account_id=$1 AND provider_metadata->>'source_signature'=$2 AND source_evidence_id<>$3 LIMIT 1`,[account.id,t.metadata.source_signature,evidence.id])).rowCount!>0;
   await client.query(`INSERT INTO finance_os.bank_transactions(bank_account_id,first_sync_run_id,last_sync_run_id,source_record_id,provider_transaction_id,status,occurred_at,booking_date,amount,currency,direction,merchant_name,reference,description,provider_category,provider_code,provider_metadata,source_evidence_id,source_row,reconciliation_status,conflict_payload) VALUES($1,$2,$2,$3,$4,'booked',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[account.id,runId,t.sourceRecordId,t.providerTransactionId,t.occurredAt,t.bookingDate,t.amount,t.currency,t.direction,t.merchantName,t.reference,t.description,t.providerCategory,t.providerCode,JSON.stringify(t.metadata),evidence.id,Number(t.metadata.row_number),ambiguous?'conflict':'unmatched',ambiguous?JSON.stringify({reason:'No provider ID: possible overlap with prior export. Not safe to count as new.'}):null]);inserted++;if(ambiguous)conflicts++;
  }
  const completed=(await client.query(`UPDATE finance_os.bank_sync_runs SET status='succeeded',evidence_id=$2,fetched_count=$3,inserted_count=$4,skipped_count=$5,conflict_count=$6,finished_at=now() WHERE id=$1 RETURNING *`,[runId,evidence.id,transactions.length,inserted,skipped,conflicts])).rows[0];
  await linkEvidence(evidence.id,{entity_type:'bank_sync_run',entity_id:runId,relationship:'original_import'},userId,client);
  await logFinanceEvent({eventType:'bank.import.completed',entityType:'bank_sync_run',entityId:runId,summary:'Staged manual Monzo import; no accounting records created',metadata:{evidence_id:evidence.id,inserted,skipped,conflicts,adapter_version:monzoAdapter.version},userId,client});
  await client.query('UPDATE finance_os.bank_connections SET last_successful_sync_at=now() WHERE id=$1',[connection.id]);
  await client.query('COMMIT');return {duplicate_file:false,connection,account,sync_run:completed,transactions:[]};
 }catch(error){
  await client.query('ROLLBACK');
  if(newObjectKey)await deleteFromR2(newObjectKey).catch(()=>undefined);
  if(runId){await client.query('BEGIN');await client.query(`UPDATE finance_os.bank_sync_runs SET status='failed',error_code=$2,finished_at=now() WHERE id=$1`,[runId,(error as {code?:string}).code??'import_failed']);await logFinanceEvent({eventType:'bank.import.failed',entityType:'bank_sync_run',entityId:runId,summary:'Import failed; staged writes rolled back',userId,client});await client.query('COMMIT');}
  throw error;
 }finally{client.release();}
};
export const listBankImports=async(db:Db=pool,offset=0)=>(await db.query(`SELECT r.*,c.provider,a.display_name account_label FROM finance_os.bank_sync_runs r JOIN finance_os.bank_connections c ON c.id=r.connection_id LEFT JOIN finance_os.bank_accounts a ON a.id=r.bank_account_id ORDER BY r.started_at DESC,r.id LIMIT 100 OFFSET $1`,[offset])).rows;
export const listBankTransactions=async(db:Db=pool,offset=0)=>(await db.query(`SELECT t.*,t.booking_date::text,a.display_name account_label,c.provider,c.provider_environment FROM finance_os.bank_transactions t JOIN finance_os.bank_accounts a ON a.id=t.bank_account_id JOIN finance_os.bank_connections c ON c.id=a.connection_id ORDER BY t.booking_date DESC,t.id LIMIT 100 OFFSET $1`,[offset])).rows;
export async function matchBankTransfer(first:string,second:string,userId:string,reason:string){
 if(!reason?.trim()||first===second)throw bankError('Two distinct transactions and a review reason are required','invalid_transfer_match');
 const c=await pool.connect();try{await c.query('BEGIN');const rows=(await c.query(`SELECT t.*,a.classification,c.provider_environment FROM finance_os.bank_transactions t JOIN finance_os.bank_accounts a ON a.id=t.bank_account_id JOIN finance_os.bank_connections c ON c.id=a.connection_id WHERE t.id=ANY($1::uuid[]) ORDER BY t.id FOR UPDATE OF t`,[[first,second]])).rows;
 if(rows.length!==2||rows.some(r=>r.reconciliation_status!=='unmatched'||r.status!=='booked')||rows[0].bank_account_id===rows[1].bank_account_id||rows[0].provider_environment!==rows[1].provider_environment||rows[0].currency!==rows[1].currency||decimal(String(rows[0].amount))+decimal(String(rows[1].amount))!==0n)throw bankError('Transfer requires two unmatched booked equal-and-opposite same-currency rows in the same environment','invalid_transfer_match');
 await c.query(`UPDATE finance_os.bank_transactions SET reconciliation_status='matched',match_kind='transfer',counterpart_transaction_id=CASE WHEN id=$1 THEN $2::uuid ELSE $1::uuid END,reviewed_by=$3,reviewed_at=now() WHERE id=ANY($4::uuid[])`,[first,second,userId,[first,second]]);
 await logFinanceEvent({eventType:'bank.transfer.matched',entityType:'bank_transaction',entityId:first,summary:reason,metadata:{counterpart_id:second,financial_action:false},userId,client:c});await c.query('COMMIT');return {matched:true,financial_action:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
