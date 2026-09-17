import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { calculateOwnership, calculateScenario, assessSnapshot, validateScenario, initialiseReadiness, updateRequirement, saveScenario, getReadiness, addActivity, updateEngagement } from './fundraising-readiness.service';
import { requirePrivateFinance } from '../middleware/finance-private';

const holding = {shareholder:'Test founder',shareholder_type:'Individual',share_class:'Ordinary',shares:1,nominal_value:1,amount_paid:1,amount_unpaid:0,acquisition_date:'2025-05-08',voting_rights:'One vote per share'};
test('unknown values remain unknown; no valuation is invented',()=>{
  assert.equal(calculateScenario(250000,null).available,false);
  assert.deepEqual(validateScenario({name:'Unpriced preparation'}),{name:'Unpriced preparation',proposed_investment:null,pre_money_valuation:null,baseline_id:null,notes:''});
  for(const value of [0,-1,NaN,Infinity,'250000',1.001]) assert.throws(()=>validateScenario({name:'Invalid',proposed_investment:value}));
  assert.throws(()=>validateScenario({name:'Invalid',status:'RECEIVED'}));
});
test('simple round dilution reconciles without mutating actual counts',()=>{
  const source=structuredClone([holding]);
  const result=calculateScenario(250000,1000000,source);
  assert.equal(result.investor_ownership,0.2);
  assert.equal(result.holdings?.[0]?.after,0.8);
  assert.equal(result.theoretical_new_shares,0.25);
  assert.equal(result.requires_share_rounding_review,true);
  assert.deepEqual(source,[holding]);
  assert.equal(calculateOwnership([holding]).total_ownership,1);
  assert.throws(()=>calculateOwnership([]));
  assert.throws(()=>calculateOwnership([{...holding,shares:0}]));
  assert.throws(()=>calculateOwnership([{...holding,amount_paid:NaN}]));
});
test('stale evidence and future snapshots cannot supply verified ownership',()=>{
  const snapshot={effective_date:'2025-05-08',verification_status:'VERIFIED',evidence_status:'Verified',evidence_document_status:'Active',evidence_version:1,current_evidence_version:1,holdings:[holding]};
  assert.equal(assessSnapshot(snapshot).usable,true);
  assert.equal(assessSnapshot({...snapshot,current_evidence_version:2}).usable,false);
  assert.equal(assessSnapshot({...snapshot,effective_date:'2099-01-01'}).usable,false);
  assert.equal(assessSnapshot({...snapshot,evidence_status:'Under Review'}).usable,false);
});
test('working financial records fail closed for every non-founder role',()=>{
  for(const role of [undefined,'investor','investor_nda','advisor','revoked_user']) {
    let status=0;let called=false;
    requirePrivateFinance({dataRoomUser:{role}} as never,{status:(s:number)=>{status=s;return {json:()=>{}};}} as never,()=>{called=true;});
    assert.equal(status,403);assert.equal(called,false);
  }
  let allowed=false;
  requirePrivateFinance({dataRoomUser:{role:'founder_admin'}} as never,{} as never,()=>{allowed=true;});
  assert.equal(allowed,true);
});

// Run only against a disposable database explicitly supplied by the developer.
// This test refuses the ordinary DATABASE_URL and never loads production fixtures.
test('PostgreSQL migration, evidence gates, history and scenario isolation', {skip:!process.env.READINESS_TEST_DATABASE_URL}, async()=>{
  const url=process.env.READINESS_TEST_DATABASE_URL!;
  const parsed=new URL(url);
  assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/readiness_test');assert.equal(parsed.port,'55439');
  const p=new Pool({connectionString:url});const db=await p.connect();
  const user='11111111-1111-4111-8111-111111111111';const company='22222222-2222-4222-8222-222222222222';const ev='33333333-3333-4333-8333-333333333333';
  try {
    await db.query('CREATE SCHEMA finance_os; CREATE SCHEMA data_room; CREATE TABLE data_room.users(id uuid PRIMARY KEY); CREATE TABLE finance_os.company(id uuid PRIMARY KEY,company_number text,legal_name text); CREATE TABLE finance_os.evidence(id uuid PRIMARY KEY,title text,version integer,verification_status text,document_status text,r2_object_key text); CREATE TABLE data_room.documents(id uuid PRIMARY KEY,evidence_id uuid,storage_path text,access_level text);');
    await db.query('INSERT INTO data_room.users VALUES ($1)',[user]);
    await db.query("INSERT INTO finance_os.company VALUES ($1,'16436591','Test company')",[company]);
    await db.query("INSERT INTO finance_os.evidence VALUES ($1,'Test document',1,'Unverified','Active','private/test.pdf')",[ev]);
    await db.query(readFileSync('server/sql/20260915_fundraising_readiness.sql','utf8'));
    await db.query('BEGIN');const first=await initialiseReadiness(user,db);await db.query('COMMIT');
    await db.query('BEGIN');const second=await initialiseReadiness(user,db);await db.query('COMMIT');
    assert.equal(first.id,second.id);
    const before=await getReadiness(db);assert.equal(before.engagement.budget_ex_vat,'995.00');assert.equal(before.requirements.length,29);
    assert.equal(before.ownership.length,0);assert.equal(before.scenarios.length,0);
    const r=before.requirements[0];
    const input={version:1,classification:'AVAILABLE + VERIFIED',notes:'Reviewed',owner:'Founder',next_action:'Retain evidence',evidence_id:ev,review_confirmed:true};
    await assert.rejects(()=>updateRequirement(r.id,input,user,db),/verified canonical evidence/);
    await db.query("UPDATE finance_os.evidence SET verification_status='Verified' WHERE id=$1",[ev]);
    await db.query('BEGIN');await updateRequirement(r.id,input,user,db);await db.query('COMMIT');
    assert.equal((await db.query('SELECT founder_only FROM finance_os.evidence WHERE id=$1',[ev])).rows[0].founder_only,true);
    await db.query("INSERT INTO data_room.documents VALUES ($1,$2,'private/test.pdf','investor_nda')",[company,ev]);
    const guards=readFileSync('server/src/routes/data-room.routes.ts','utf8').match(/CASE WHEN EXISTS \(SELECT 1 FROM finance_os\.evidence private_e[^\n]+?END AS access_level/g) ?? [];
    assert.equal(guards.length,3,'list, signed URL issuance and signed URL redemption all enforce privacy');
    for(const guard of guards) assert.equal((await db.query(`SELECT ${guard} FROM data_room.documents d`)).rows[0].access_level,'founder_only');
    await db.query('UPDATE data_room.documents SET evidence_id=NULL');
    for(const guard of guards) assert.equal((await db.query(`SELECT ${guard} FROM data_room.documents d`)).rows[0].access_level,'founder_only','storage-path alias cannot bypass confidentiality');
    await assert.rejects(()=>updateRequirement(r.id,input,user,db),/changed/);
    await assert.rejects(()=>addActivity(first.id,{kind:'payment_reference',description:'Claimed payment',source:'Test'},user,db),/evidence is required/);
    await assert.rejects(()=>updateEngagement(first.id,{version:1,status:'Complete',reason:'Attempt early completion',evidence_id:ev},user,db),/Outstanding/);
    await db.query('BEGIN');await saveScenario(first.id,{name:'Unpriced',proposed_investment:250000},user,db);await db.query('COMMIT');
    const after=await getReadiness(db);assert.equal(after.ownership.length,0);assert.equal(after.scenarios.length,1);assert.equal(after.scenarios[0].calculation.available,false);
    assert.equal((await db.query('SELECT count(*) FROM finance_os.fundraising_engagements')).rows[0].count,'1');
    await assert.rejects(()=>db.query("UPDATE finance_os.fundraising_activity SET description='rewrite'"),/append-only/);
    await db.query("INSERT INTO finance_os.ownership_snapshots(company_id,scope,effective_date,verification_status,holdings,evidence_id,evidence_version,review_notes,approved_by) VALUES ($1,'HISTORICAL','2025-05-08','VERIFIED',$2,$3,1,'Test-only evidence',$4)",[company,JSON.stringify([holding]),ev,user]);
    await assert.rejects(()=>db.query('DELETE FROM finance_os.ownership_snapshots'),/append-only/);
    const historical=(await getReadiness(db)).ownership[0];assert.equal(historical.usable,true);assert.equal(historical.effective_date,'2025-05-08');
    await db.query('BEGIN');await updateEngagement(first.id,{version:1,status:'In progress',reason:'Confirmed service date',service_purchased:'Test service',start_date:'2026-09-15',evidence_id:ev},user,db);await db.query('COMMIT');
    assert.equal((await getReadiness(db)).engagement.start_date,'2026-09-15');
    await db.query('BEGIN');await updateEngagement(first.id,{version:2,status:'Awaiting provider',reason:'Waiting for evidence',service_purchased:'Test service',start_date:'2026-09-15'},user,db);await db.query('COMMIT');
    await db.query('UPDATE finance_os.evidence SET version=2 WHERE id=$1',[ev]);
    assert.equal((await getReadiness(db)).ownership[0].usable,false);
    await assert.rejects(()=>saveScenario(first.id,{name:'Stale baseline',proposed_investment:250000,pre_money_valuation:1000000,baseline_id:historical.id},user,db),/Baseline requires/);
  } finally {db.release();await p.end();}
});

test('verified one-share holding remains actual when subdivision is approved only in principle',async()=>{
  const {subdivisionReview}=await import('./subdivision-review');
  const actual=[{...holding,shareholder:'Emma Louise Mendez'}];
  assert.equal(subdivisionReview([]),null);
  const proposal=subdivisionReview([{kind:'founder_decision',payload:{decision_key:'subdivision-review-20260917'}}]);
  assert.equal(proposal?.scope,'PROPOSED_NOT_CURRENT');assert.equal(proposal?.shares,10000);
  assert.equal(proposal?.nominal_value,0.0001);assert.equal(proposal?.executed,false);assert.equal(proposal?.filed,false);assert.equal(proposal?.resolution_passing_date,null);
  assert.equal(calculateOwnership(actual).shares,1);assert.equal(calculateOwnership(actual).nominal_capital,1);
  assert.equal(calculateOwnership(actual).holdings[0].shareholder,'Emma Louise Mendez');
  assert.equal(calculateOwnership(actual).total_ownership,1);
  assert.throws(()=>validateScenario({name:'Try execute',shares:10000,executed:true}));
});
