import { decimal, format, minimum, pennies, multiply, min, max, SCALE } from './finance-decimal';
export const CREDIT_ENGINE_VERSION='credit-daily-v1';
export type CreditScenarioInput={
 mode:'full'|'minimum'|'fixed'|'period'; opening_purchase?:string; opening_cash?:string;
 proposed_amount?:string; proposed_kind?:'purchase'|'cash_withdrawal'; proposed_date?:string;
 start_date?:string; first_statement_date?:string; due_days?:number; horizon_months?:number;
 purchase_daily_rate?:string; cash_daily_rate?:string; rate_assumption_source?:string;
 purchase_interest_free?:boolean; fixed_payment?:string; payoff_months?:number;
 cash_on_hand?:string; monthly_cash_receipts?:string; monthly_direct_cash_costs?:string;
 assumptions_acknowledged?:boolean; equal_rate_allocation?:'purchase_first'|'cash_first';
 no_other_debt_or_arrears?:boolean; no_further_spending?:boolean;
};
type Row={date:string;statement_balance:string;required_minimum:string;payment:string;interest:string;closing_debt:string;purchase_debt:string;cash_debt:string;cash_remaining:string|null;shortfall:string};
const validDate=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const addDays=(s:string,n:number)=>new Date(Date.parse(s)+n*86400000).toISOString().slice(0,10);
function monthDate(s:string,n:number){const d=new Date(s),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,end));return d.toISOString().slice(0,10);}
export function projectionMissing(i:CreditScenarioInput){
 const missing:string[]=[];
 for(const key of ['opening_purchase','opening_cash','purchase_daily_rate','cash_daily_rate'] as const){try{if(decimal(i[key])<0n)missing.push(key);}catch{missing.push(key);}}
 for(const key of ['start_date','first_statement_date'] as const)if(!validDate(i[key]))missing.push(key);
 if(i.start_date&&i.first_statement_date&&i.first_statement_date<i.start_date)missing.push('statement must follow start');
 if(validDate(i.start_date)&&validDate(i.first_statement_date)&&Date.parse(i.first_statement_date)-Date.parse(i.start_date)>31*86400000)missing.push('first statement must be within 31 days of start');
 if(validDate(i.proposed_date)&&validDate(i.first_statement_date)&&i.proposed_date>monthDate(i.first_statement_date,(i.horizon_months??60)-1))missing.push('proposed transaction must be within projection horizon');
 if(!Number.isInteger(i.due_days)||i.due_days!<1||i.due_days!>27)missing.push('explicit payment clearing offset (1–27 calendar days)');
 if(typeof i.purchase_interest_free!=='boolean')missing.push('purchase interest-free history');
 if(!i.rate_assumption_source?.trim())missing.push('daily rate source/assumption');
 if(!i.assumptions_acknowledged)missing.push('explicit estimate assumptions acknowledgement');
 if(!i.no_other_debt_or_arrears)missing.push('opening debt/arrears completeness (complex arrears require statement reconciliation)');
 if(!i.no_further_spending)missing.push('no further spending assumption');
 if(!['purchase_first','cash_first'].includes(i.equal_rate_allocation??''))missing.push('equal-rate allocation assumption');
 if(i.mode==='fixed'){try{if(decimal(i.fixed_payment)<=0n)missing.push('positive fixed payment');}catch{missing.push('fixed payment');}}
 if(i.mode==='period'&&(!Number.isInteger(i.payoff_months)||i.payoff_months!<1||i.payoff_months!>120))missing.push('payoff period (1–120 months)');
 if(!['full','minimum','fixed','period'].includes(i.mode))missing.push('repayment mode');
 if(i.proposed_amount!==undefined){try{if(decimal(i.proposed_amount)<0n)missing.push('proposed amount');}catch{missing.push('proposed amount');}if(!validDate(i.proposed_date)||i.proposed_date<i.start_date!)missing.push('proposed debit date');if(!['purchase','cash_withdrawal'].includes(i.proposed_kind??''))missing.push('transaction kind');}
 for(const k of ['cash_on_hand','monthly_cash_receipts','monthly_direct_cash_costs'] as const)if(i[k]!==undefined){try{if(decimal(i[k])<0n)missing.push(k);}catch{missing.push(k);}}
 if(i.horizon_months!==undefined&&(!Number.isInteger(i.horizon_months)||i.horizon_months<1||i.horizon_months>120))missing.push('horizon (1–120 months)');
 for(const k of ['purchase_daily_rate','cash_daily_rate'] as const){try{if(decimal(i[k])>SCALE)missing.push('daily rate cannot exceed 100%');}catch{/* already missing */}}
 return missing;
}
/** Pure hypothetical simulation. Daily rates, clearing dates and tie-breaking are explicit estimates, never contract facts. */
function simulate(i:CreditScenarioInput,fixed?:bigint){
 let purchase=decimal(i.opening_purchase),cash=decimal(i.opening_cash),purchaseAccrued=0n,cashAccrued=0n,interest=0n,total=0n;
 const pr=decimal(i.purchase_daily_rate),cr=decimal(i.cash_daily_rate),months=i.horizon_months??60;
 let eligible=i.purchase_interest_free!,cashRemaining=i.cash_on_hand!==undefined&&i.monthly_cash_receipts!==undefined&&i.monthly_direct_cash_costs!==undefined?decimal(i.cash_on_hand):null;
 let statementPurchase=0n,statementCash=0n,statementBalance=0n,statementInterest=0n,required=0n,due='',shortfallDate:string|null=null,payoff:string|null=null;
 const cashTimeline:Array<{date:string;cash:string}>=[];
 const rows:Row[]=[],statements=new Set(Array.from({length:months},(_,n)=>monthDate(i.first_statement_date!,n)));
 const end=addDays(monthDate(i.first_statement_date!,months-1),i.due_days!);
 let purchaseApplied=i.proposed_amount===undefined;
 for(let day=i.start_date!;day<=end;day=addDays(day,1)){
  if(!purchaseApplied&&day===i.proposed_date){const x=decimal(i.proposed_amount);if(i.proposed_kind==='cash_withdrawal'){cash+=x;/* Destination cash is intentionally not assumed. */}else purchase+=x;purchaseApplied=true;}
  if(statements.has(day)){
   // Accrual since last statement becomes posted debt. Conditional purchase accrual is retained until due-date decision.
   const ci=pennies(cashAccrued);cash+=ci;cashAccrued=0n;interest+=ci;statementInterest=ci;
   if(!eligible){const pi=pennies(purchaseAccrued);purchase+=pi;interest+=pi;statementInterest+=pi;purchaseAccrued=0n;}
   statementPurchase=purchase;statementCash=cash;statementBalance=purchase+cash;required=pennies(minimum(statementBalance));due=addDays(day,i.due_days!);
  }
  if(day===due){
   const desired=i.mode==='full'?statementBalance:i.mode==='minimum'?required:fixed??decimal(i.fixed_payment);
   const payment=min(purchase+cash,desired),shortfall=max(0n,required-payment);
   // If a previously eligible statement is not cleared, post the conditional estimate accumulated since the start/last payment.
   if(eligible&&payment<statementBalance){const pi=pennies(purchaseAccrued);purchase+=pi;interest+=pi;statementInterest+=pi;purchaseAccrued=0n;eligible=false;}
   else if(payment>=statementBalance){eligible=true;purchaseAccrued=0n;}
   let remaining=payment;
   const purchaseFirst=pr>cr||(pr===cr&&i.equal_rate_allocation==='purchase_first');
   const apply=(kind:'purchase'|'cash',cap:bigint)=>{const taken=min(remaining,min(cap,kind==='purchase'?purchase:cash));if(kind==='purchase')purchase-=taken;else cash-=taken;remaining-=taken;};
   // Statemented sums precede unstatemented amounts. Minimum is part of the payment, never an additional deduction.
   if(purchaseFirst){apply('purchase',statementPurchase);apply('cash',statementCash);}else{apply('cash',statementCash);apply('purchase',statementPurchase);}
   if(purchaseFirst){apply('purchase',purchase);apply('cash',cash);}else{apply('cash',cash);apply('purchase',purchase);}
   total+=payment;
   if(cashRemaining!==null){cashRemaining+=decimal(i.monthly_cash_receipts)-decimal(i.monthly_direct_cash_costs)-payment;if(cashRemaining<0n&&!shortfallDate)shortfallDate=day;cashTimeline.push({date:day,cash:format(cashRemaining)});}
   const debt=purchase+cash+pennies(cashAccrued)+(eligible?0n:pennies(purchaseAccrued));
   if(!payoff)rows.push({date:day,statement_balance:format(statementBalance),required_minimum:format(required),payment:format(payment),interest:format(statementInterest),closing_debt:format(debt),purchase_debt:format(purchase),cash_debt:format(cash),cash_remaining:cashRemaining===null?null:format(cashRemaining),shortfall:format(shortfall)});
   if(debt===0n&&purchaseApplied&&!payoff)payoff=day;
  }
  // Payment is assumed cleared at start of date, so repaid principal does not accrue that day.
  purchaseAccrued+=multiply(purchase,pr);cashAccrued+=multiply(cash,cr);
 }
 return {schedule:rows,cash_timeline:cashTimeline,estimated_interest:format(interest),estimated_total_repayment:format(total),payoff_date:payoff,remaining_debt:format(purchase+cash+pennies(cashAccrued)+(eligible?0n:pennies(purchaseAccrued))),cash_shortfall_date:shortfallDate,cash_runway_status:cashRemaining===null?'not_available':shortfallDate?'shortfall_projected':'no_shortfall_within_horizon',status:payoff?'paid_off':'not_repaid_within_horizon'};
}
export function calculateCreditScenario(i:CreditScenarioInput){
 const missing=projectionMissing(i);
 if(missing.length)return {engine_version:CREDIT_ENGINE_VERSION,status:'blocked',missing,assumptions:i,financial_action:false} as const;
 let chosen:bigint|undefined;
 if(i.mode==='period'){
  let low=0n,high=(decimal(i.opening_purchase)+decimal(i.opening_cash)+decimal(i.proposed_amount??'0')+SCALE)*100n;
  const candidate={...i,mode:'fixed' as const,horizon_months:i.payoff_months};
  const feasible=(amount:bigint)=>{const s=simulate(candidate,amount);return s.payoff_date!==null&&s.schedule.every(r=>r.shortfall==='0.00');};
  if(!feasible(high))return {engine_version:CREDIT_ENGINE_VERSION,status:'blocked',missing:['No feasible payoff within the selected period and bound'],assumptions:i,financial_action:false} as const;
  while(high-low>1000000n){const mid=((high+low)/2000000n)*1000000n;if(feasible(mid))high=mid;else low=mid+1000000n;}chosen=high;if(!feasible(chosen))chosen+=1000000n;
 }
 const result=simulate(i,chosen),full=simulate({...i,mode:'full'}),withoutPurchase=simulate({...i,proposed_amount:undefined,mode:i.mode},chosen);
 return {...result,engine_version:CREDIT_ENGINE_VERSION,estimate:true,financial_action:false,assumptions:{...i,horizon_months:i.horizon_months??60},missing:[],fixed_payment:chosen===undefined?null:format(chosen),
  difference_vs_full:{interest:format(decimal(result.estimated_interest)-decimal(full.estimated_interest)),total_repaid_within_horizon:format(decimal(result.estimated_total_repayment)-decimal(full.estimated_total_repayment)),full_payoff_date:full.payoff_date},
  purchase_impact:{additional_interest:format(decimal(result.estimated_interest)-decimal(withoutPurchase.estimated_interest)),cash_shortfall_without_purchase:withoutPurchase.cash_shortfall_date,cash_shortfall_with_purchase:result.cash_shortfall_date},
  limitations:['Explicit daily rates are estimates, not contractual APR or the current applied rate.','Monthly cycle and calendar-day clearing offset are selected assumptions; actual obligations require statements.','Opening arrears, arrangements, unknown fees and complex historical eligibility are unsupported and block this simplified scenario.','Cash runway here uses explicit monthly receipts/costs at payment dates; intra-period operating cash timing remains unknown.','Trailing cash interest may require a further statement.'],
 };
}
