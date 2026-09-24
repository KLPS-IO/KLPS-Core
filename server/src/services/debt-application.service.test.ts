import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { amount, indicativePayment, validateData, budgetSummary, itemReady, psbSummary, initialiseDebtApplication, getDebtWorkspace, updateDebtApplication, saveDebtItem, getPrivatePsb, savePrivatePsb, reconcilePrivatePsb, addDebtInteraction, recordDebtReview } from './debt-application.service';
import { PSB_ROWS, SEEDS, WORKBOOK } from './debt-application.template';
import { requirePrivateFinance } from '../middleware/finance-private';

test('loan request produces indicative arithmetic only, including zero rate; unknown is not zero',()=>{
 assert.deepEqual([amount(null),amount(''),amount(0)],[null,null,0]);
 for(const v of [-1,Infinity,NaN,'100',1.001])assert.throws(()=>amount(v));
 assert.equal(indicativePayment(7000,60,.075).monthly,140.27);
 assert.equal(indicativePayment(7000,60,.075).total,8415.94);
 assert.equal(indicativePayment(6000,60,0).monthly,100);
 assert.throws(()=>indicativePayment(7000,0,.075));
});
test('budget does not allocate unknown quotes or historical sales; VAT totals reconcile',()=>{
 const items=SEEDS.map(r=>({...r,data:validateData(r.section,r.data)}));
 assert.deepEqual(budgetSummary(items,7000),{provisional_allocated:1194,evidenced_eligible:0,unallocated:5806,unknown_cost_lines:1,overallocated:false});
 assert.equal(budgetSummary(items,1000).overallocated,true);
 assert.throws(()=>validateData('budget',{net:995,vat:199,gross:1000}),/equal gross/);
 assert.equal(validateData('budget',{}).gross,null);
 assert.throws(()=>validateData('budget',{account_number:'secret'}),/Unsupported/);
 for(const s of items.filter(i=>i.section==='commercial'))assert.equal(s.data.amount,null);
 for(const s of items.filter(i=>i.section==='forecast'))for(let m=1;m<=12;m++)assert.equal(s.data[`m${m}`],null);
});
test('private PSB remains unknown until all official rows are reviewed; repayment is deducted once',()=>{
 assert.equal(PSB_ROWS.length,29);
 assert.equal(psbSummary([],140.27).monthly_income,null);
 const rows=PSB_ROWS.map(r=>({...r,status:'Not applicable',monthly_amount:null}));
 rows[0]={...rows[0],status:'Reviewed',monthly_amount:2000 as never};
 rows[8]={...rows[8],status:'Reviewed',monthly_amount:1500 as never};
 const p=psbSummary(rows,140.27);assert.equal(p.ready,true);assert.equal(p.after_proposed_payment,359.73);
 assert.equal(psbSummary(rows.slice(1),140.27).ready,false);
 assert.equal(psbSummary(rows.map((r,i)=>i===0?{...r,evidence_id:'changed',evidence_version:1,current_evidence_version:2}:r),140.27).ready,false);
});
test('revision/file-version and evidence status are all readiness gates',()=>{
 const r={status:'Resolved',evidence_id:'test',evidence_version:2,current_evidence_version:2,evidence_file_version:'1',current_file_version:1,evidence_status:'Verified',document_status:'Active'};
 assert.equal(itemReady(r),true);
 for(const change of [{current_evidence_version:3},{current_file_version:2},{evidence_status:'Under Review'},{document_status:'Archived'},{status:'Provisional'}])assert.equal(itemReady({...r,...change}),false);
});
test('founder gates and route ordering protect both general and personal application endpoints',()=>{
 for(const role of [undefined,'advisor','investor','authorised']){
  let denied=false;requirePrivateFinance({dataRoomUser:{role}} as never,{status:(n:number)=>{assert.equal(n,403);return {json:()=>{denied=true;}};}} as never,()=>assert.fail('unauthorised'));assert.equal(denied,true);
 }
 const route=readFileSync('server/src/routes/finance.routes.ts','utf8');
 assert.ok(route.indexOf('  requirePrivateFinance\n')<route.indexOf("router.get('/debt-applications'"));
 assert.match(route,/router.use\('\/debt-applications'.*private, no-store/);
});

test('real PostgreSQL: migration, private scope, full edits, immutable provenance, stale evidence and no ledger writes',{skip:!process.env.DEBT_TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.DEBT_TEST_DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55481');assert.equal(url.pathname,'/debt_workspace_test');
 const pool=new Pool({connectionString:url.toString()});const db=await pool.connect();
 const owner='11111111-1111-4111-8111-111111111111',other='11111111-1111-4111-8111-222222222222',company='22222222-2222-4222-8222-222222222222',evidence='33333333-3333-4333-8333-333333333333';
 const tx=async<T>(operation:()=>Promise<T>)=>{await db.query('BEGIN');try{const result=await operation();await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}};
 try{
  await db.query(`CREATE SCHEMA finance_os; CREATE SCHEMA data_room;
   CREATE TABLE data_room.users(id uuid PRIMARY KEY);
   CREATE TABLE finance_os.company(id uuid PRIMARY KEY,company_number text,legal_name text);
   CREATE TABLE finance_os.evidence(id uuid PRIMARY KEY,title text,version integer,file_version integer,checksum text,verification_status text,document_status text);
   CREATE TABLE finance_os.bank_connections(id uuid,provider_environment text);
   CREATE TABLE finance_os.bank_accounts(id uuid,connection_id uuid,classification text,currency text,status text);
   CREATE TABLE finance_os.bank_balance_observations(id uuid,bank_account_id uuid,metric text,value numeric,currency text,as_of timestamptz,review_status text,evidence_id uuid);
   CREATE TABLE finance_os.vat_filings(id uuid,obligation_reference text,submitted_at timestamptz,result text,box_4 numeric,box_5 numeric,box_6 numeric);
   CREATE TABLE finance_os.expenses(id uuid,founder_paid boolean,archived_at timestamptz);
   CREATE TABLE finance_os.funding(id uuid);
   CREATE TABLE finance_os.bank_transactions(id uuid);
   CREATE TABLE finance_os.credit_facilities(id uuid);`);
  await db.query('INSERT INTO data_room.users VALUES($1),($2)',[owner,other]);
  await db.query("INSERT INTO finance_os.company VALUES($1,'16436591','Test company')",[company]);
  await db.query("INSERT INTO finance_os.evidence VALUES($1,'Original workbook',1,1,$2,'Verified','Active')",[evidence,WORKBOOK.sha256]);
  await db.query(readFileSync('server/sql/20260915_fundraising_readiness.sql','utf8'));
  await db.query(readFileSync('server/sql/20260923_debt_application_workspace.sql','utf8'));
  await db.query(readFileSync('server/sql/20260924_debt_psb_reconciliation.sql','utf8'));
  const app=await tx(()=>initialiseDebtApplication(owner,db));assert.equal((await tx(()=>initialiseDebtApplication(owner,db))).id,app.id);
  let w=await getDebtWorkspace(owner,db);assert.equal(w.applications.length,1);let a=w.applications[0];
  assert.equal(a.budget.unallocated,5806);assert.equal(a.summary.cash_flow_ready,false);assert.equal(w.position.cash.value,null);
  assert.equal((await getDebtWorkspace(other,db)).applications.length,0);
  await assert.rejects(()=>getPrivatePsb(app.id,other,db),/not found/);
  await assert.rejects(()=>tx(()=>updateDebtApplication(app.id,{version:1},other,db)),/not found/);
  const p=await getPrivatePsb(app.id,owner,db);assert.equal(p.entries.length,29);
  const input={version:1,monthly_amount:1900,status:'Reviewed',source:'Personal payslips, retained privately',source_date:'2026-09-20',period_start:'2026-06-01',period_end:'2026-08-31',rationale:'Continuing net employment income',review_confirmed:true};
  await tx(()=>savePrivatePsb(app.id,p.entries[0].id,input,owner,db));
  await assert.rejects(()=>tx(()=>savePrivatePsb(app.id,p.entries[0].id,input,owner,db)),/changed/);
  await assert.rejects(()=>tx(()=>savePrivatePsb(app.id,p.entries[1].id,{...input,source:'password: secret'},owner,db)),/credentials/);
  await assert.rejects(()=>tx(()=>savePrivatePsb(app.id,p.entries[1].id,{...input,status:'Not applicable'},owner,db)),/blank amount/);
  // Synthetic working intake: no real personal figures belong in committed tests.
  const working={...input,status:'Working reconciled',classification:'Founder-confirmed recurring amount',source:'PRIVATE_SYNTHETIC_SOURCE',period_start:null,period_end:null};
  for(const entry of (await getPrivatePsb(app.id,owner,db)).entries){const isIncome=entry.workbook_row===25,isExpense=entry.workbook_row===49;await tx(()=>savePrivatePsb(app.id,entry.id,{...working,version:entry.version,monthly_amount:isIncome?2100:isExpense?1600:null,status:isIncome||isExpense?'Working reconciled':'Not applicable',classification:isIncome||isExpense?working.classification:'Not applicable'},owner,db));}
  const context={entry_versions:(await getPrivatePsb(app.id,owner,db)).entries.map((e:any)=>({id:e.id,version:e.version})),previous_reconciliation_id:null,source:'PRIVATE_SYNTHETIC_CHECKPOINT',source_date:'2026-09-20',commitments:[{label:'PRIVATE_SYNTHETIC_DEBT',kind:'temporary',balance:120,monthly_payment:null,basis:'Instalment timing pending',classification:'Founder statement'}],exclusions:[],warnings:['PRIVATE_SYNTHETIC_WARNING'],expected_income:2100,expected_expenses:1600,review_confirmed:true};
  await assert.rejects(()=>tx(()=>reconcilePrivatePsb(app.id,{...context,expected_expenses:1601},owner,db)),/totals differ/);
  await assert.rejects(()=>tx(()=>reconcilePrivatePsb(app.id,{...context,commitments:[1,2].map(()=>({...context.commitments[0],monthly_payment:1000,included_psb_row:49}))},owner,db)),/exceed/);
  await assert.rejects(()=>tx(()=>reconcilePrivatePsb(app.id,context,other,db)),/not found/);
  await tx(()=>reconcilePrivatePsb(app.id,context,owner,db));
  await assert.rejects(()=>tx(()=>reconcilePrivatePsb(app.id,context,owner,db)),/changed/);
  assert.equal((await getPrivatePsb(app.id,owner,db)).summary.working_reconciled,true);
  assert.equal((await getPrivatePsb(app.id,owner,db)).summary.ready,false);
  assert.equal((await getDebtWorkspace(owner,db)).applications[0].summary.psb.working_reconciled,true);
  await tx(()=>recordDebtReview(app.id,{reason:'Synthetic reconciliation review',review_confirmed:true},owner,db));
  assert.equal(JSON.stringify(await getDebtWorkspace(owner,db)).includes('PRIVATE_SYNTHETIC'),false);
  await assert.rejects(()=>db.query('DELETE FROM finance_os.debt_psb_reconciliations'),/append-only/);
  const changed=(await getPrivatePsb(app.id,owner,db)).entries[0];
  await tx(()=>savePrivatePsb(app.id,changed.id,{...working,version:changed.version,monthly_amount:2101},owner,db));
  assert.equal((await getDebtWorkspace(owner,db)).applications[0].summary.psb.working_reconciled,false);
  const publicView=JSON.stringify(await getDebtWorkspace(owner,db));assert.equal(publicView.includes('Personal payslips'),false);assert.equal(publicView.includes('monthly_amount'),false);assert.equal(publicView.includes('Continuing net employment income'),false);
  const doc=a.items.find((i:any)=>i.code==='original-workbook');
  const docInput={version:1,data:doc.data,status:'Resolved',classification:'Extracted fact',source:'Original official download',source_date:'2026-09-23',evidence_id:evidence,evidence_version:1,evidence_file_version:1,locator:'Whole workbook',rationale:'Checksum verified, original preserved; defects remain',review_confirmed:true,next_action:'Await replacement template'};
  await assert.rejects(()=>tx(()=>saveDebtItem(app.id,doc.id,{...docInput,data:{...doc.data.sha256,filename:'changed'}},owner,db)));
  await tx(()=>saveDebtItem(app.id,doc.id,docInput,owner,db));
  assert.equal((await db.query('SELECT founder_only FROM finance_os.evidence WHERE id=$1',[evidence])).rows[0].founder_only,true);
  a=(await getDebtWorkspace(owner,db)).applications[0];assert.equal(a.items.find((i:any)=>i.id===doc.id).ready,true);
  await db.query('UPDATE finance_os.evidence SET file_version=2 WHERE id=$1',[evidence]);
  a=(await getDebtWorkspace(owner,db)).applications[0];assert.equal(a.items.find((i:any)=>i.id===doc.id).ready,false);
  await assert.rejects(()=>tx(()=>saveDebtItem(app.id,doc.id,{...docInput,version:2},owner,db)),/Evidence version changed/);
  const forecast=a.items.find((i:any)=>i.code==='forecast-sales');
  await assert.rejects(()=>tx(()=>saveDebtItem(app.id,forecast.id,{...docInput,evidence_id:null,data:{basis:'No unsupported receipts'},classification:'Assumption'},owner,db)),/Twelve explicit/);
  await assert.rejects(()=>tx(()=>saveDebtItem(app.id,forecast.id,{...docInput,evidence_id:null,data:{...Object.fromEntries(Array.from({length:12},(_,i)=>[`m${i+1}`,100])),cash_direction:'Cash receipt',basis:'Unsupported sales'},classification:'Assumption'},owner,db)),/first sales month/);
  const fdata=Object.fromEntries(Array.from({length:12},(_,i)=>[`m${i+1}`,0]));
  await tx(()=>saveDebtItem(app.id,forecast.id,{...docInput,evidence_id:null,data:{...fdata,cash_direction:'Cash receipt',basis:'Explicit zero based on founder-reviewed no-sales timing'},classification:'Assumption'},owner,db));
  const newBudget=await tx(()=>saveDebtItem(app.id,null,{section:'budget',title:'Controlled prototype testing',application_field:'BP use of funds',status:'External evidence',data:{description:'Controlled strain tests',purpose:'Validate measurement repeatability'},classification:'Unknown',rationale:'Quote needed',next_action:'Request scope and quote'},owner,db));assert.ok(newBudget.id);
  await tx(()=>updateDebtApplication(app.id,{version:1,requested_amount:5000,term_months:48,forecast_start:'2026-10-01',status:'Awaiting external evidence',reason:'Provisional reduction for review'},owner,db));
  await assert.rejects(()=>tx(()=>updateDebtApplication(app.id,{version:1,requested_amount:4000},owner,db)),/changed/);
  await assert.rejects(()=>tx(()=>updateDebtApplication(app.id,{version:2,requested_amount:5000,term_months:48,status:'Approved',reason:'Not allowed'},owner,db)),/Invalid application status/);
  await tx(()=>addDebtInteraction(app.id,{kind:'adviser interaction',description:'Requested eligibility clarification',source:'Founder note',occurred_on:'2026-09-23'},owner,db));
  await tx(()=>recordDebtReview(app.id,{reason:'Pass 2 founder review with open blockers',review_confirmed:true},owner,db));
  const reviews=(await db.query("SELECT snapshot FROM finance_os.debt_application_history WHERE entity_kind='review'")).rows;
  assert.equal(reviews[0].snapshot.status,'Internal review only — not submitted');assert.ok(reviews[0].snapshot.private_psb_versions);assert.equal(JSON.stringify(reviews).includes('monthly_amount'),false);
  await assert.rejects(()=>db.query('DELETE FROM finance_os.debt_application_history'),/append-only/);
  await assert.rejects(()=>db.query('UPDATE finance_os.debt_psb_history SET entry_version=100'),/append-only/);
  for(const table of ['funding','bank_transactions','credit_facilities'])assert.equal((await db.query(`SELECT count(*)::integer n FROM finance_os.${table}`)).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::integer n FROM finance_os.debt_applications')).rows[0].n,1);
 }finally{db.release();await pool.end();}
});
