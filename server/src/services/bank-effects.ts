import {decimal,format} from './finance-decimal';
type Leg={id:string;classification:'cash_current'|'revolving_credit'|'unknown';amount:string;counterpart_id?:string|null;matched:boolean};
/** Read-side projection only. Two feed legs have one cash effect and one debt effect; never revenue. */
export function reviewedTransferEffect(legs:Leg[]){
 if(legs.length!==2||legs.some(l=>!l.matched||l.classification==='unknown')||legs[0].counterpart_id!==legs[1].id||legs[1].counterpart_id!==legs[0].id||decimal(legs[0].amount)+decimal(legs[1].amount)!==0n)throw new Error('Reviewed reciprocal transfer required');
 const cash=legs.filter(l=>l.classification==='cash_current').reduce((s,l)=>s+decimal(l.amount),0n);
 const debt=legs.filter(l=>l.classification==='revolving_credit').reduce((s,l)=>s-decimal(l.amount),0n);
 return {cash_delta:format(cash),debt_delta:format(debt),revenue_delta:'0.00'};
}
