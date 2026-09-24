import { fail, required } from './fundraising-readiness.service';
import { PSB_ROWS } from './debt-application.template';
type Row=Record<string,any>;
export const PSB_CLASSIFICATIONS=['Unclassified','Founder-confirmed recurring amount','Statement-derived (founder confirmed)','Founder-approved normalised assumption','Not applicable'];
export const PSB_POLICY=[
 {code:'own-transfers',rule:'Transfers between the applicant’s own accounts are neither income nor expenditure.'},
 {code:'savings',rule:'Savings transfers are not ordinary household consumption; any ongoing saving commitment requires separate explicit treatment.'},
 {code:'credit-repayments',rule:'Do not duplicate purchases, repayments leaving accounts and the monthly credit minimum already included in the budget.'},
 {code:'drawings',rule:'Business drawings count as personal income only to the extent actually available to the applicant.'},
 {code:'direct-benefit',rule:'Business-paid personal benefits already included in drawings/rent must not be added again to either income or expenditure.'},
 {code:'historical',rule:'Ended and one-off historical purchases do not automatically become recurring expenditure.'},
 {code:'child-contributions',rule:'Variable child-related contributions are disclosed privately but excluded from core affordability and fallback; they are not partner income.'},
 {code:'new-loan',rule:'The proposed new loan repayment is excluded from existing PSB credit commitments and deducted once in the indicative affordability comparison.'},
 {code:'cff',rule:'Treat proposed loan receipt/repayment separately in the application CFF; never create canonical financing from preparation.'},
 {code:'integrity',rule:'Never alter a figure to improve affordability. Food classification follows merchant/context, not transaction size.'}
];
const round=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const keys=(o:Row,allowed:string[])=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))throw fail('Unsupported private reconciliation fields');};
export function privateText(value:unknown,label='Private provenance'){
 const s=required(value,label);if(s.length>1500||/(?:\d[ -]?){12,19}|\b(?:password|pin|cvv|cvc|iban|account number|sort code)\s*[:=]/i.test(s))throw fail('Use short provenance only; no credentials, account/card numbers or detailed credit reports');return s;
}
const monetary=(v:unknown,nullable=true):number|null=>{if(v==null&&nullable)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e9||Math.abs(v*100-Math.round(v*100))>0.0001)throw fail('Invalid private amount');return v;};
export function validateComponents(value:unknown,monthly:number|null){
 if(!Array.isArray(value)||value.length>30)throw fail('A private category breakdown must be an array of at most 30 components');
 const components=value.map(v=>{keys(v,['label','monthly_amount','classification','basis']);const classification=privateText(v.classification,'Classification');if(!PSB_CLASSIFICATIONS.includes(classification)||classification==='Unclassified')throw fail('Choose a component classification');return {label:privateText(v.label,'Component label'),monthly_amount:monetary(v.monthly_amount,false)!,classification,basis:privateText(v.basis,'Component basis')};});
 if(components.length&&(monthly===null||components.reduce((sum,c)=>sum+Math.round(c.monthly_amount*100),0)!==Math.round(monthly*100)))throw fail('Category components do not equal the monthly amount; reconciliation stopped');
 return components;
}
export function validatePrivateContext(input:Row){
 keys(input,['source','source_date','source_sha256','commitments','exclusions','warnings','expected_income','expected_expenses','review_confirmed','entry_versions','previous_reconciliation_id']);
 if(input.review_confirmed!==true)throw fail('Explicit founder reconciliation confirmation required');
 if(!Array.isArray(input.entry_versions)||input.entry_versions.length!==PSB_ROWS.length||input.entry_versions.some((v:Row)=>!v||typeof v.id!=='string'||!Number.isSafeInteger(v.version)||v.version<1)||new Set(input.entry_versions.map((v:Row)=>v.id)).size!==PSB_ROWS.length)throw fail('Current private entry revisions required');
 if(input.previous_reconciliation_id!=null&&(typeof input.previous_reconciliation_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.previous_reconciliation_id)))throw fail('Invalid prior reconciliation');
 const source=privateText(input.source,'Reconciliation source'),sourceDate=input.source_date;
 if(typeof sourceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)||!Number.isFinite(Date.parse(sourceDate))||new Date(sourceDate).toISOString().slice(0,10)!==sourceDate||sourceDate>new Date().toISOString().slice(0,10))throw fail('Valid reconciliation source date required');
 if(input.source_sha256!=null&&(typeof input.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.source_sha256)))throw fail('Invalid source fingerprint');
 if(!Array.isArray(input.commitments)||input.commitments.length>30||!Array.isArray(input.exclusions)||input.exclusions.length>30||!Array.isArray(input.warnings)||input.warnings.length>30)throw fail('Invalid private disclosures');
 const commitments=input.commitments.map((c:Row)=>{keys(c,['label','kind','balance','monthly_payment','apr','end_month','period_start_month','period_end_month','included_psb_row','basis','classification']);
  if(!['revolving','hire_purchase','temporary','paid_off'].includes(c.kind))throw fail('Invalid commitment kind');
  for(const k of ['end_month','period_start_month','period_end_month'])if(c[k]!=null&&(typeof c[k]!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(c[k])))throw fail('Invalid commitment month');
  if(c.period_start_month&&c.period_end_month&&c.period_end_month<c.period_start_month)throw fail('Invalid commitment period');
  if(c.included_psb_row!=null&&!PSB_ROWS.some(r=>r.kind==='expense'&&r.row===c.included_psb_row))throw fail('Invalid PSB commitment mapping');
  const apr=monetary(c.apr);if(apr!=null&&apr>100)throw fail('Invalid disclosed APR');
  return {label:privateText(c.label),kind:c.kind,balance:monetary(c.balance),monthly_payment:monetary(c.monthly_payment),apr,end_month:c.end_month??null,period_start_month:c.period_start_month??null,period_end_month:c.period_end_month??null,included_psb_row:c.included_psb_row??null,basis:privateText(c.basis),classification:privateText(c.classification)};
 });
 const exclusions=input.exclusions.map((e:Row)=>{keys(e,['label','classification','reason','amount','date']);if(e.date!=null&&(typeof e.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||!Number.isFinite(Date.parse(e.date))||new Date(e.date).toISOString().slice(0,10)!==e.date))throw fail('Invalid excluded event date');return {label:privateText(e.label),classification:privateText(e.classification),reason:privateText(e.reason),amount:monetary(e.amount),date:e.date??null};});
 return {source,source_date:sourceDate,source_sha256:input.source_sha256??null,commitments,exclusions,warnings:input.warnings.map((w:unknown)=>privateText(w)),expected_income:monetary(input.expected_income,false),expected_expenses:monetary(input.expected_expenses,false)};
}
function unchanged(r:Row){return !r.evidence_id||(r.current_evidence_version===r.evidence_version&&String(r.current_file_version??'')===String(r.evidence_file_version??'')&&r.document_status==='Active');}
function complete(r:Row){if(r.status==='Not applicable')return r.monthly_amount==null;return ['Reviewed','Working reconciled'].includes(r.status)&&r.monthly_amount!=null&&unchanged(r);}
export function reconciliationSummary(rows:Row[],payment:number,checkpoint?:Row|null){
 const totalsAvailable=rows.length===PSB_ROWS.length&&rows.every(complete);
 const evidenceReady=totalsAvailable&&rows.every(r=>r.status==='Not applicable'||(r.status==='Reviewed'&&(!r.evidence_id||r.evidence_status==='Verified')));
 const matches=!!checkpoint&&checkpoint.entry_versions.length===rows.length&&rows.every(r=>checkpoint.entry_versions.some((v:Row)=>v.id===r.id&&v.version===r.version));
 const reconciled=totalsAvailable&&matches;
 const sum=(kind:string)=>rows.filter(r=>r.kind===kind&&r.status!=='Not applicable').reduce((n,r)=>n+Math.round(Number(r.monthly_amount)*100),0)/100;
 const income=totalsAvailable?sum('income'):null,expenses=totalsAvailable?sum('expense'):null;
 const temporaryUnresolved=!!checkpoint?.commitments.some((c:Row)=>c.kind==='temporary'&&c.balance>0&&c.monthly_payment===null);
 return {ready:evidenceReady,working_reconciled:reconciled,checkpoint_current:matches,inputs_complete:totalsAvailable,
 complete:rows.filter(complete).length,total:PSB_ROWS.length,evidence_follow_up:!evidenceReady||!!checkpoint?.warnings.length,
 monthly_income:income,monthly_expenses:expenses,annual_income:income==null?null:round(income*12),annual_expenses:expenses==null?null:round(expenses*12),monthly_surplus:income==null||expenses==null?null:round(income-expenses),after_proposed_payment:income==null||expenses==null?null:round(income-expenses-payment),temporary_commitments_unresolved:temporaryUnresolved,
 affordability:!totalsAvailable?'Unknown — private intake requires reconciliation':!reconciled&&!evidenceReady?'Private figures changed — reconcile again':temporaryUnresolved?'Normalised PSB reconciled; temporary commitment timing remains unresolved':income!-expenses!<payment?'Indicative shortfall — founder review required':'Indicative surplus only — lender assessment and evidence review still required',
 rule:'Working normalised inputs are not a claim that historical spending matched each month. The new loan repayment is deducted once in this private comparison. Temporary commitments are disclosed separately and may reduce near-term headroom.'};
}
