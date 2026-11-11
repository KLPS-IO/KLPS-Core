import OpenAI, { toFile } from 'openai';
import { toBritishEnglish } from './customer-british-english';
import { pool } from '../storage/postgres.client';
import { readFromR2 } from './r2.service';

export const TRANSCRIPTION_MODEL = 'gpt-transcribe';
export type TranscriptJob = { id: string; interview_id: string; question_key: string; audio_object_key: string; model: string };
export async function transcribeRecording(bytes: Buffer, contentType: string, apiKey: string, transport?: typeof fetch): Promise<string> {
  const extension = (contentType.includes('mp4') || contentType.includes('m4a')) ? 'm4a' : contentType.includes('mpeg') ? 'mp3' : contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'webm';
  if (extension === 'ogg') throw new Error('Please convert this Ogg recording to WebM or WAV before transcription. The original audio is preserved.');
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120000, ...(transport ? {fetch: transport} : {}) });
  const result = await client.audio.transcriptions.create({ file: await toFile(bytes, `answer.${extension}`, { type: contentType }), model: TRANSCRIPTION_MODEL, prompt: 'A UK English customer-research interview. British spellings include realise, personalised, colour, behaviour, centre and fibre. Preserve the speakers’ wording and incomplete phrases.' });
  if (!result.text?.trim()) throw new Error('No speech transcript was returned. Please check the audio before retrying.');
  return result.text.trim();
}
export function safeTranscriptionError(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  if (status === 401 || status === 403) return 'The transcription service could not authorise this request. Check the server API key and model access.';
  if (status === 429) return 'The transcription provider reached its usage or rate limit. Check API billing, then retry explicitly.';
  if (status === 404) return 'The configured transcription model is unavailable for this API project. Check model access.';
  if (status === 400 || status === 413 || status === 415) return 'The provider could not process this recording format. Your original audio is preserved.';
  return 'Transcription was not confirmed. Your audio is preserved. Check before retrying; an interrupted provider request may still have incurred a charge.';
}
let running = false;
export async function runTranscriptionQueue(): Promise<void> {
  if (running || !process.env.OPENAI_API_KEY) return;
  running = true;
  try {
    // A process may have stopped after a paid request. Never silently repeat it.
    await pool.query(`UPDATE research_field_transcripts SET status='failed', error_message='Processing was interrupted. Review and retry explicitly.', updated_at=now(), revision=revision+1 WHERE status='processing' AND started_at < now()-interval '10 minutes'`);
    for (let index=0; index<7; index++) {
      const claimed = await pool.query(`UPDATE research_field_transcripts SET status='processing', started_at=now(), updated_at=now(), attempts=attempts+1, error_message=NULL, revision=revision+1 WHERE id=(SELECT id FROM research_field_transcripts WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) AND status='queued' RETURNING id, interview_id, question_key, audio_object_key, model`);
      const job = claimed.rows[0] as TranscriptJob | undefined;
      if (!job) break;
      try {
        const record = (await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1', [job.interview_id])).rows[0]?.payload;
        const audio = record?.audio?.find((a: {objectKey:string;questionKey:string})=>a.objectKey===job.audio_object_key && a.questionKey===job.question_key);
        if (!record?.audioConsent || !audio) { await pool.query("UPDATE research_field_transcripts SET status='obsolete',updated_at=now() WHERE id=$1",[job.id]); continue; }
        const file = await readFromR2(job.audio_object_key);
        const text = await transcribeRecording(file.body, audio.contentType, process.env.OPENAI_API_KEY!);
        await pool.query(`UPDATE research_field_transcripts SET status='draft', original_text=$2, edited_text=$3, completed_at=now(), updated_at=now(), revision=revision+1 WHERE id=$1 AND status='processing'`, [job.id,text,toBritishEnglish(text)]);
      } catch (error) {
        await pool.query("UPDATE research_field_transcripts SET status='failed',error_message=$2,updated_at=now(),revision=revision+1 WHERE id=$1 AND status='processing'",[job.id,safeTranscriptionError(error)]);
      }
    }
  } catch { console.error('Private interview transcription queue check failed'); }
  finally { running = false; }
}
const timer = setInterval(()=>{void runTranscriptionQueue();},10000);
timer.unref();
