import test from 'node:test';
import assert from 'node:assert/strict';
import { validateComponents, validatePrivateContext, reconciliationSummary, PSB_POLICY } from './debt-psb-reconciliation';
import { PSB_ROWS } from './debt-application.template';
import { readinessGates, PASS3_BUSINESS_ITEMS } from './debt-readiness';
import { validateData } from './debt-application.service';
const classification='Founder-approved normalised assumption';
const context={entry_versions:PSB_ROWS.map((_,i)=>({id:String(i),version:1})),previous_reconciliation_id:null,source:'Synthetic founder intake',source_date:'2026-09-20',commitments:[],exclusions:[],warnings:['Statements not independently reviewed'],expected_income:2100,expected_expenses:1700,review_confirmed:true};
test('components reconcile in pence without silently adjusting inputs; reject secrets and unknown fields',()=>{
 const parts=[{label:'Utility A',monthly_amount:30.11,classification,basis:'Synthetic input'},{label:'Utility B',monthly_amount:21.22,classification,basis:'Synthetic input'}];
 assert.equal(validateComponents(parts,51.33).length,2);
 assert.throws(()=>validateComponents(parts,51.34),/reconciliation stopped/);
 assert.throws(()=>validateComponents([{...parts[0],basis:'account number: 123456789012'}],30.11),/credentials/);
 assert.throws(()=>validatePrivateContext({...context,secret:'x'}),/Unsupported/);
 assert.throws(()=>validatePrivateContext({...context,review_confirmed:false}),/Explicit/);
 assert.equal(PSB_POLICY.length,10);
});
test('working reconciliation pins versions, preserves source caveats and temporary commitments without adding them to totals',()=>{
 const rows=PSB_ROWS.map((r,i)=>({id:String(i),version:2,kind:r.kind,status:'Not applicable',monthly_amount:null as number|null}));
 rows[0]={...rows[0],status:'Working reconciled',monthly_amount:2100};rows[8]={...rows[8],status:'Working reconciled',monthly_amount:1700};
 const checkpoint={entry_versions:rows.map(r=>({id:r.id,version:r.version})),warnings:context.warnings,commitments:[{kind:'temporary',balance:120,monthly_payment:null}]};
 const summary=reconciliationSummary(rows,100,checkpoint);
 assert.equal(summary.working_reconciled,true);assert.equal(summary.ready,false);assert.equal(summary.monthly_surplus,400);assert.equal(summary.after_proposed_payment,300);assert.equal(summary.temporary_commitments_unresolved,true);
 assert.equal(reconciliationSummary(rows.map((r,i)=>i===0?{...r,version:3}:r),100,checkpoint).working_reconciled,false);
 assert.equal(reconciliationSummary(rows.map((r,i)=>i===0?{...r,evidence_id:'e',evidence_version:1,current_evidence_version:2}:r),100,checkpoint).inputs_complete,false);
});
test('business fields retain unknown costs and forecasts; hypotheses do not become validated prices',()=>{
 for(const item of PASS3_BUSINESS_ITEMS){const data=validateData(item.section,item.data);if(item.section==='forecast')for(let m=1;m<=12;m++)assert.equal(data[`m${m}`],null);if(item.section==='economics'){assert.equal(data.proposed_retail_price,null);assert.equal(data.landed_unit_cost,null);assert.equal(data.gross_margin,null);}}
 assert.equal(validateData('economics',{gross_margin:-10}).gross_margin,-10);
 assert.throws(()=>validateData('engineering',{net:100,vat:20,gross:110}),/equal gross/);
});
test('readiness propagates unresolved dependencies and keeps independent quote/economic work available',()=>{
 const codes=['cash','liabilities','founder-funding','recurring','vat','product-economics','commercial-2','commercial-3','commercial-1','commercial-4','commercial-5','commercial-6','development-milestones','forecast-loan','fallback','workbook-fitness'];
 const items=codes.map(code=>({code,ready:code!=='product-economics',section:'requirement'}));items.push({code:'f',ready:true,section:'forecast'});
 const gates=readinessGates(items,{working_reconciled:true},{cash:{value:0}},{requested_amount:100,forecast_start:'2026-10-01'},{evidenced_eligible:100,unallocated:0});
 assert.equal(gates.find(g=>g.id==='D')!.ready,false);assert.deepEqual(gates.find(g=>g.id==='D')!.waiting_on,['E']);assert.equal(gates.find(g=>g.id==='F')!.ready,true);assert.deepEqual(gates.find(g=>g.id==='C')!.dependencies,[]);
});

test('CFF preview stays absent until reviewed inputs; calculates receipts and payments once in pence',async()=>{
 const {cashFlowPreview}=await import('./debt-readiness');
 const row={code:'forecast-proposed-loan',section:'forecast',ready:true,data:{cash_direction:'Cash receipt',...Object.fromEntries(Array.from({length:12},(_,i)=>[`m${i+1}`,i===0?100:0]))}};
 const cost={...row,code:'cost',data:{...row.data,cash_direction:'Cash payment',m1:30.11,m2:20.22}};
 assert.equal(cashFlowPreview([row,cost],{cash:{value:null}},{forecast_start:'2026-10-01'}),null);
 assert.equal(cashFlowPreview([{...row,ready:false},cost],{cash:{value:50}},{forecast_start:'2026-10-01'}),null);
 const preview=cashFlowPreview([row,cost],{cash:{value:50}},{forecast_start:'2026-10-01'})!;
 assert.equal(preview[0].closing,119.89);assert.equal(preview[1].closing,99.67);assert.equal(preview[11].month,'2027-09');
});
