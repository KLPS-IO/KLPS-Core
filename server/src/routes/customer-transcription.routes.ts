import { Router } from 'express';
import { pool } from '../storage/postgres.client';
import { requireDataRoomAuth, requireAdmin } from '../services/data-room.service';
import { runTranscriptionQueue, TRANSCRIPTION_MODEL } from '../services/customer-transcription.service';
const router = Router();
router.use(requireDataRoomAuth, requireAdmin);
router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicJob=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='audio_object_key'));
router.get('/:id/transcripts',async(req,res)=>{
 if(!uuid.test(String(req.params.id))){res.sendStatus(400);return;}
 try {
  const record=(await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1',[req.params.id])).rows[0]?.payload;
  if(!record){res.sendStatus(404);return;}
  const result=await pool.query('SELECT * FROM research_field_transcripts WHERE interview_id=$1 ORDER BY created_at',[req.params.id]);
  const transcripts=result.rows.filter(r=>(record.audio||[]).some((a:{questionKey:string;objectKey:string})=>a.questionKey===r.question_key&&a.objectKey===r.audio_object_key)).map(publicJob);
  res.json({configured:Boolean(process.env.OPENAI_API_KEY),model:TRANSCRIPTION_MODEL,transcripts});
 }catch{res.status(503).json({error:'Transcripts are unavailable. Please retry.'});}
});
router.post('/:id/transcripts',async(req,res)=>{
 if(!uuid.test(String(req.params.id))){res.sendStatus(400);return;}
 if(!process.env.OPENAI_API_KEY){res.status(503).json({error:'Add OPENAI_API_KEY to the KLPS backend before transcribing.'});return;}
 try{
  const record=(await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1',[req.params.id])).rows[0]?.payload;
  if(!record){res.sendStatus(404);return;}
  if(!record.audioConsent){res.status(400).json({error:'Recording consent is required.'});return;}
  const audio=record.audio||[];if(!audio.length){res.status(400).json({error:'This interview has no saved recordings.'});return;}
  for(const take of audio){
   await pool.query(`INSERT INTO research_field_transcripts(interview_id,question_key,audio_object_key,model) VALUES($1,$2,$3,$4) ON CONFLICT(interview_id,question_key,audio_object_key) DO NOTHING`,[req.params.id,take.questionKey,take.objectKey,TRANSCRIPTION_MODEL]);
   if(req.body?.retryFailed===true)await pool.query(`UPDATE research_field_transcripts SET status='queued',error_message=NULL,updated_at=now(),revision=revision+1 WHERE interview_id=$1 AND question_key=$2 AND audio_object_key=$3 AND status='failed'`,[req.params.id,take.questionKey,take.objectKey]);
  }
  res.status(202).json({queued:true});void runTranscriptionQueue();
 }catch{res.status(503).json({error:'Could not queue transcription. Saved recordings remain available.'});}
});
router.patch('/:id/transcripts/:transcriptId',async(req,res)=>{
 if(!uuid.test(String(req.params.id))||!uuid.test(String(req.params.transcriptId))){res.sendStatus(400);return;}
 const {text,approve,revision}=req.body||{};
 if(typeof text!=='string'||!text.trim()||text.length>100000||typeof approve!=='boolean'||!Number.isInteger(revision)||revision<0){res.status(400).json({error:'A transcript, explicit review action and current revision are required.'});return;}
 try{
  const result=await pool.query(`UPDATE research_field_transcripts t SET edited_text=$3,status=$4,approved_at=CASE WHEN $4='approved' THEN now() ELSE NULL END,updated_at=now(),revision=revision+1 WHERE t.id=$1 AND t.interview_id=$2 AND t.revision=$5 AND t.status IN ('draft','approved') AND EXISTS(SELECT 1 FROM research_field_interviews i,jsonb_array_elements(COALESCE(i.payload->'audio','[]'::jsonb)) a WHERE i.id=t.interview_id AND a->>'objectKey'=t.audio_object_key AND a->>'questionKey'=t.question_key) RETURNING *`,[req.params.transcriptId,req.params.id,text.trim(),approve?'approved':'draft',revision]);
  if(!result.rows.length){res.status(409).json({error:'This transcript or its recording changed. Reload before saving.'});return;}
  res.json({transcript:publicJob(result.rows[0])});
 }catch{res.status(503).json({error:'Transcript changes were not confirmed saved. Keep your edits and retry.'});}
});
export default router;
