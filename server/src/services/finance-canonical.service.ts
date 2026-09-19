import crypto from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { decimal,format,divide,SCALE } from './finance-decimal';
export const FINANCE_MODEL_VERSION='cash-authority-v1';
type RecordRow=Record<string,any>;
export function cashAuthority(accounts:RecordRow[],observations:RecordRow[],now:string){
 const cashAccounts=accounts.filter(a=>a.classification==='cash_current'&&a.provider_environment==='production'&&a.status==='enabled');
 const records=cashAccounts.map(a=>observations.filter(o=>o.bank_account_id===a.id&&o.metric==='cash_booked'&&o.currency==='GBP'&&o.as_of<=now).sort((a,b)=>b.as_of.localeCompare(a.as_of))[0]);
 const missing=cashAccounts.length===0||accounts.some(a=>a.classification==='unknown'&&a.status==='enabled'&&a.provider_environment==='production')||records.some(x=>!x||x.review_status!=='reviewed')||cashAccounts.some(a=>a.currency!=='GBP');
 const stale=records.some(o=>o&&Date.parse(now)-Date.parse(o.as_of)>86400000);
 return {value:missing||stale?null:format(records.reduce((s,o)=>s+decimal(String(o.value)),0n)),currency:'GBP',state:missing?'not_evidenced':stale?'stale':'reviewed',as_of:missing?null:records.map(o=>o.as_of).sort()[0],observation_ids:records.filter(Boolean).map(o=>o.id),freshness_policy:'24 hours; all classified enabled production cash accounts required'};
}
export async function canonicalFinance(scenarioKey='base',db:Pick<PoolClient,'query'>=pool,now=new Date().toISOString()):Promise<any>{
 if(db===pool){const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await canonicalFinance(scenarioKey,client,now);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
 const scenario=(await db.query('SELECT id,key,name FROM finance_os.scenarios WHERE key=$1',[scenarioKey])).rows[0]??{id:null,key:scenarioKey,name:scenarioKey};
 const accounts=(await db.query('SELECT a.*,c.provider,c.provider_environment FROM finance_os.bank_accounts a JOIN finance_os.bank_connections c ON c.id=a.connection_id')).rows;
 const observations=(await db.query('SELECT o.*,o.as_of::text FROM finance_os.bank_balance_observations o ORDER BY o.as_of DESC,o.recorded_at DESC')).rows.map(o=>({...o,as_of:new Date(o.as_of).toISOString()}));
 const assumptions=(await db.query(`SELECT a.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('evidence_id',e.id,'file_version',e.file_version,'verification_status',e.verification_status)) FROM finance_os.evidence_links l JOIN finance_os.evidence e ON e.id=l.evidence_id WHERE l.entity_type='assumption' AND l.entity_id=a.id AND e.document_status='Active'),'[]'::jsonb) AS evidence FROM finance_os.assumptions a WHERE (scenario_id=$1 OR scenario_id IS NULL) AND status<>'deprecated' ORDER BY name`,[scenario.id])).rows;
 const funding=(await db.query(`SELECT * FROM finance_os.funding WHERE (scenario_id=$1 OR scenario_id IS NULL) AND status<>'withdrawn' ORDER BY expected_date`,[scenario.id])).rows;
 const facilities=(await db.query(`SELECT f.*,t.id term_version_id,t.version term_version,t.terms,t.provenance term_provenance,t.review_status FROM finance_os.credit_facilities f LEFT JOIN LATERAL (SELECT * FROM finance_os.credit_term_versions WHERE facility_id=f.id ORDER BY version DESC LIMIT 1) t ON true`)).rows;
 const statements=(await db.query('SELECT s.*,s.statement_date::text,s.due_date::text FROM finance_os.credit_statements s ORDER BY s.statement_date DESC NULLS LAST,s.version DESC')).rows;
 const actualCash=cashAuthority(accounts,observations,now);
 const reviewedAssumption=(name:string)=>{
  const candidates=assumptions.filter(a=>a.name===name&&a.status==='active'&&a.evidence.some((e:RecordRow)=>e.verification_status==='Verified'));
  const specific=candidates.filter(a=>a.scenario_id===scenario.id),selected=specific.length?specific:candidates.filter(a=>a.scenario_id===null);
  return selected.length===1&&selected[0].unit==='GBP/month'?selected[0]:null;
 };
 // These explicit cash timing inputs must exclude card purchases and repayments; no category-name guesses.
 const receipts=reviewedAssumption('monthly_cash_receipts'),costs=reviewedAssumption('monthly_direct_cash_payments');
 const series:Array<{month:string;cash:string;forecast_cash:string;repayments:string}>=[];
 let cashRunway:string|null=null,forecastRunway:string|null=null;
 const credit=facilities.map(f=>{
  const metric=(kind:string)=>{const o=observations.find(o=>o.bank_account_id===f.bank_account_id&&o.metric===kind&&o.currency===f.currency&&o.as_of<=now);return o&&o.review_status==='reviewed'&&Date.parse(now)-Date.parse(o.as_of)<=86400000?{value:String(o.value),as_of:o.as_of,evidence_id:o.evidence_id,id:o.id}:null;};
  const limit=metric('credit_limit'),debt=metric('outstanding_debt'),available=metric('available_credit');
  const latestStatement=statements.find(s=>s.facility_id===f.id);const statement=latestStatement?.review_status==='reviewed'?latestStatement:null;
  return {...f,portal_observation:accounts.find(a=>a.id===f.bank_account_id)?.metadata?.portal_observation??null,limit,available,debt,statement,utilisation:limit&&debt&&decimal(limit.value)>0n?format(divide(decimal(debt.value)*100n*SCALE,decimal(limit.value))):null};
 });
 const missing:string[]=[];
 if(actualCash.value===null)missing.push('Current evidenced cash for every cash account');
 if(!receipts)missing.push('Verified monthly_cash_receipts (GBP/month) assumption');
 if(!costs)missing.push('Verified monthly_direct_cash_payments (GBP/month), excluding card spending/repayments');
 // Outstanding facilities require a chosen repayment schedule, not an invented minimum forecast.
 if(credit.some(f=>!f.debt||decimal(f.debt.value)!==0n))missing.push('Evidenced credit debt and selected repayment schedule');
 if(!missing.length){
  let c=decimal(actualCash.value!),f=c;
  for(let m=0;m<18;m++){
   const d=new Date(now);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+m);const month=d.toISOString().slice(0,7);
   const net=decimal(String(receipts.value))-decimal(String(costs.value));c+=net;f+=net;
   // Planned/committed receipts appear only in the explicitly labelled forecast, never actual cash.
   f+=funding.filter(r=>['planned','committed'].includes(r.status)&&r.expected_date&&new Date(r.expected_date).toISOString().startsWith(month)).reduce((s,r)=>s+decimal(String(r.amount)),0n);
   if(c<0n&&cashRunway===null)cashRunway=String(m+1);if(f<0n&&forecastRunway===null)forecastRunway=String(m+1);
   series.push({month,cash:format(c),forecast_cash:format(f),repayments:'0.00'});
  }
 }
 const hires=(await db.query('SELECT * FROM finance_os.hires WHERE scenario_id=$1 OR scenario_id IS NULL',[scenario.id])).rows;
 const risks=(await db.query('SELECT * FROM finance_os.risks WHERE scenario_id=$1 OR scenario_id IS NULL',[scenario.id])).rows;
 const inputs={scenario,accounts,observations,assumptions,funding,facilities,statements,hires,risks};
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({version:FINANCE_MODEL_VERSION,inputs})).digest('hex');
 return {engine_version:FINANCE_MODEL_VERSION,input_fingerprint:fingerprint,calculated_at:now,source_as_of:actualCash.as_of,scenario,actual_cash:actualCash,
 planned_funding:funding.length?format(funding.filter(f=>['planned','committed'].includes(f.status)).reduce((s,f)=>s+decimal(String(f.amount)),0n)):null,
 cash_only_runway_months:cashRunway,forecast_runway_months:forecastRunway,runway_status:missing.length?'not_available':cashRunway===null?'no_shortfall_within_18_months':'projected_shortfall',
 forecast_missing:missing,series,credit,assumptions,funding,hires,risks,inputs,
 outputs:{actual_cash:actualCash.value,planned_funding:funding.length?format(funding.filter(f=>['planned','committed'].includes(f.status)).reduce((s,f)=>s+decimal(String(f.amount)),0n)):null,runway_months:cashRunway,forecast_runway_months:forecastRunway,revenue:null,costs:null,gross_profit:null,net_burn:null,average_confidence:null,metrics:{},engine_version:FINANCE_MODEL_VERSION}};
}
