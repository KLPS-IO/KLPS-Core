import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalFinance} from './finance-canonical.service';
// Synthetic unit fixture only. No database or provider is contacted.
test('portal credit capacity and zero debt preserve unknown cash, payment, income and runway',async()=>{
 const now='2026-09-18T23:00:00.000Z';
 const portal={evidence_id:'synthetic-image',as_of:now,period_display:'Aug 23 - Sep 22',period_year:null,next_payment_display:'29 Sep',next_payment_year:null,payment_amount:null,payment_configuration_display:'Minimum · Monthly'};
 const accounts=[{id:'credit',classification:'revolving_credit',status:'enabled',currency:'GBP',provider_environment:'production',metadata:{portal_observation:portal}},{id:'monzo',classification:'unknown',status:'enabled',currency:'GBP',provider_environment:'production'}];
 const observations=[['credit_limit','2500'],['available_credit','2500'],['outstanding_debt','0']].map(([metric,value])=>({id:metric,bank_account_id:'credit',metric,value,currency:'GBP',as_of:now,review_status:'reviewed',evidence_id:'synthetic-image'}));
 const db={query:async(sql:string)=>({rows:sql.includes('SELECT a.*,c.provider')?accounts:sql.includes('SELECT o.*')?observations:sql.includes('SELECT f.*')?[{id:'facility',bank_account_id:'credit',currency:'GBP'}]:sql.includes('SELECT id,key,name')?[{id:'base',key:'base'}]:[]})};
 const result=await canonicalFinance('base',db as never,now);assert.equal(result.actual_cash.value,null);assert.equal(result.outputs.revenue,null);assert.equal(result.planned_funding,null);assert.equal(result.cash_only_runway_months,null);assert.deepEqual(result.funding,[]);assert.deepEqual(result.series,[]);assert.equal(result.credit[0].debt.value,'0');assert.equal(result.credit[0].utilisation,'0.00');assert.equal(result.credit[0].statement,null);assert.deepEqual(result.credit[0].portal_observation,portal);assert.equal(result.credit[0].available.evidence_id,'synthetic-image');
 observations[1].value='999999';const higher=await canonicalFinance('base',db as never,now);assert.deepEqual(higher.actual_cash,result.actual_cash);assert.equal(higher.cash_only_runway_months,result.cash_only_runway_months);assert.equal(higher.outputs.revenue,result.outputs.revenue);assert.deepEqual(higher.funding,result.funding);
});
