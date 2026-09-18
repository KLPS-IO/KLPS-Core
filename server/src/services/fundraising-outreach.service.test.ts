import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUpdate,OUTREACH_STAGES} from './fundraising-outreach.service';
const value={category:'Prototype',description:'Evidenced bench milestone',evidence_id:'11111111-1111-4111-8111-111111111111',occurred_on:'2026-09-17'};
test('Alma milestones require evidence and never approve sending or downstream events',()=>{
 assert.equal(validateUpdate(value).category,'Prototype');
 for(const extra of [{sent_at:'2026-09-17'},{approved:true},{stage:'COMMITMENT'},{cash_received:2000},{shares:10000},{investor_email:'test@example.com'}])assert.throws(()=>validateUpdate({...value,...extra}),/Unsupported/);
 assert.throws(()=>validateUpdate({...value,evidence_id:null}));
 assert.throws(()=>validateUpdate({...value,occurred_on:'2099-01-01'}));
 assert.throws(()=>validateUpdate({...value,occurred_on:'2026-02-31'}));
 assert.throws(()=>validateUpdate({...value,category:'500 investor leads'}));
 assert.equal(new Set(OUTREACH_STAGES).size,9);
 assert.notEqual(OUTREACH_STAGES.indexOf('COMMITMENT'),OUTREACH_STAGES.indexOf('CASH RECEIVED'));
});
