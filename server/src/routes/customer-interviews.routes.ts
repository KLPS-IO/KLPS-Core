import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
import { requireDataRoomAuth, requireAdmin } from '../services/data-room.service';
import { uploadToR2, readFromR2, deleteFromR2 } from '../services/r2.service';

const router = Router();
router.use(requireDataRoomAuth, requireAdmin);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
const keys = new Set(['story', 'impact', 'alternative', 'gap', 'outcome', 'concepts', 'offer', 'reflection']);
const types = new Set(['audio/webm', 'video/webm', 'audio/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/ogg', 'audio/wav']);
const validKey = (key:string) => keys.has(key) || /^(story|impact|alternative|gap|outcome|concepts|offer|reflection)__[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key);
const topic = (key:string) => key.split('__')[0];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type StoredAudio = { questionKey: string; objectKey: string; contentType: string; bytes: number; durationSeconds: number; captureWarnings?: string[] };
const fields = ['id','createdAt','version','source','relationship','segment','status','story','impact','alternative','gap','outcome','frequency','spend','spendBasis','problem','offer','price','priceResponse','objection','commitment','contact','paymentReference','paidAmount','notes'];
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 8, fileSize: 20 * 1024 * 1024, fields: 1, fieldSize: 256 * 1024, parts: 9 }, fileFilter: (_req, file, cb) => cb(null, validKey(file.fieldname) && types.has(file.mimetype)) }).any();
function parseAudio(req: Request, res: Response, next: () => void) {
  if (!req.is('multipart/form-data')) { next(); return; }
  upload(req, res, error => {
    if (error) { res.status(400).json({ error: 'Invalid audio upload. Maximum 8 recordings, 20 MB each.' }); return; }
    try { req.body = JSON.parse(req.body.payload); next(); } catch { res.status(400).json({ error: 'Invalid interview payload' }); }
  });
}
function publicPayload(payload: Record<string, any>) {
  return { ...payload, audio: (payload.audio || []).map(({objectKey, ...audio}: StoredAudio) => audio) };
}
router.get('/', async (_req, res) => {
  try { const result = await pool.query('SELECT payload FROM research_field_interviews ORDER BY created_at DESC'); res.json({ interviews: result.rows.map(r => publicPayload(r.payload)) }); }
  catch { res.status(503).json({ error: 'Interview storage unavailable.' }); }
});
router.get('/:id/audio/:questionKey', async (req, res) => {
  if (!uuid.test(String(req.params.id)) || !validKey(String(req.params.questionKey))) { res.sendStatus(400); return; }
  try {
    const result = await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1', [req.params.id]);
    const audio: StoredAudio | undefined = result.rows[0]?.payload.audio?.find((a: StoredAudio) => a.questionKey === req.params.questionKey);
    if (!audio) { res.sendStatus(404); return; }
    if (req.query.transcriptId !== undefined) {
      const transcriptId = String(req.query.transcriptId);
      if (!uuid.test(transcriptId)) { res.sendStatus(400); return; }
      const match = await pool.query('SELECT id FROM research_field_transcripts WHERE id=$1 AND interview_id=$2 AND question_key=$3 AND audio_object_key=$4', [transcriptId, req.params.id, req.params.questionKey, audio.objectKey]);
      if (!match.rows.length) { res.status(409).json({ error: 'The recording no longer matches this transcript. Refresh the interview.' }); return; }
    }
    const file = await readFromR2(audio.objectKey);
    res.setHeader('Content-Type', audio.contentType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.send(file.body);
  } catch { res.status(503).json({ error: 'Private recording unavailable. Please retry.' }); }
});
router.post('/:id/clips', parseAudio, saveInterview);
router.route('/').post(parseAudio, saveInterview).put(parseAudio, saveInterview);
async function saveInterview(req: Request, res: Response) {
  const b = req.body;
  const append = Boolean(req.params.id);
  if (append && (!uuid.test(String(req.params.id)) || req.params.id !== b?.id)) { res.status(400).json({error:'Invalid interview reference.'}); return; }
  if (!b || b.adult !== true || b.consent !== true || !uuid.test(b.id) || !['klps-discovery-v1','klps-discovery-v2','klps-discovery-v3','klps-discovery-v4','klps-discovery-v5'].includes(b.version) || !['completed','partial','pilot'].includes(b.status) || typeof b.source !== 'string' || !b.source.trim()) { res.status(400).json({ error: 'Adult consent, recruitment source and valid interview required.' }); return; }
  const concept = b.concepts;
  if (!concept || typeof concept !== 'object' || Array.isArray(concept) || typeof concept.tested !== 'boolean') { res.status(400).json({ error: 'Invalid concept comparison' }); return; }
  const concepts: Record<string, unknown> = { tested: concept.tested };
  for (const key of ['garment','garmentReason','technology','technologyReason','fabric','fabricReason','style','wardrobe','routine','mainConcern','concernOrigin','insightNeed','insightAction','safetyWords','proofNeeded','burden','ageBand','wearContext','priceBasis']) {
    if (typeof concept[key] !== 'string' || concept[key].length > 4000) { res.status(400).json({ error: 'Invalid concept field' }); return; } concepts[key] = concept[key];
  }
  for (const key of ['techConcerns','order']) {
    if (!Array.isArray(concept[key]) || concept[key].length > 30 || concept[key].some((v: unknown) => typeof v !== 'string' || v.length > 200)) { res.status(400).json({ error: 'Invalid concept choices' }); return; } concepts[key] = concept[key];
  }
  const payload: Record<string, any> = { concepts };
  for (const key of fields) { if (typeof b[key] !== 'string' || b[key].length > 4000) { res.status(400).json({ error: `Invalid field: ${key}` }); return; } payload[key] = b[key]; }
  for (const key of ['spend','price','paidAmount']) { if (b[key] !== '' && (!Number.isFinite(Number(b[key])) || Number(b[key]) < 0)) { res.status(400).json({ error: 'Amounts must be non-negative.' }); return; } }
  if (!append && b.priceResponse !== 'not tested' && b.priceResponse !== 'declined' && (!b.price || !concept.priceBasis.trim())) { res.status(400).json({ error: 'Define the exact offer and price before recording a price response' }); return; }
  if (!append && b.commitment === 'paid' && (!b.paymentReference || !(Number(b.paidAmount) > 0))) { res.status(400).json({ error: 'Actual payment amount and reference required.' }); return; }
  const files = (req.files || []) as Express.Multer.File[];
  const metadata = b.newAudio || [];
  if (!Array.isArray(metadata) || metadata.length !== files.length || metadata.length > 8 || new Set(files.map(f=>f.fieldname)).size !== files.length) { res.status(400).json({ error: 'Every recorded answer must have one matching audio file.' }); return; }
  if (append && b.audioConsent !== true) { res.status(400).json({error:'Explicit voice recording consent is required.'}); return; }
  if (append && (files.length !== 1 || !files[0].fieldname.includes('__'))) { res.status(400).json({error:'One uniquely identified clip is required.'}); return; }
  for (const file of files) {
    const meta = metadata.find((m: any) => m?.questionKey === file.fieldname);
    if (meta?.captureWarnings !== undefined && (!Array.isArray(meta.captureWarnings) || meta.captureWarnings.length > 4 || meta.captureWarnings.some((code:unknown)=>typeof code!=='string'||!['microphone_muted','microphone_ended','backgrounded','recorder_error'].includes(code)))) { res.status(400).json({error:'Invalid capture warning metadata.'}); return; }
    const max = 86400;
    const signature = file.buffer.subarray(0,4).toString('hex');
    const valid = signature === '1a45dfa3' || signature === '4f676753' || signature === '52494646' || file.buffer.subarray(4,8).toString() === 'ftyp' || file.buffer.subarray(0,3).toString() === 'ID3' || (file.buffer[0] === 255 && (file.buffer[1] & 224) === 224);
    if (!valid || !meta || typeof meta.durationSeconds !== 'number' || meta.durationSeconds <= 0 || meta.durationSeconds > max) { res.status(400).json({ error: 'Invalid audio format or recording duration.' }); return; }
  }
  const uploaded: StoredAudio[] = [];
  let client: PoolClient | undefined;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.id]);
    const existing = (await client.query('SELECT payload FROM research_field_interviews WHERE id=$1', [b.id])).rows[0]?.payload;
    if (req.method === 'POST' && existing && !append) { await client.query('ROLLBACK'); res.json({ saved: true, id: b.id }); return; }
    if (req.method === 'PUT' && !existing) { await client.query('ROLLBACK'); res.status(404).json({ error: 'Interview no longer exists' }); return; }
    const previous: StoredAudio[] = existing?.audio || [];
    const duplicate = append ? previous.find(a=>a.questionKey===files[0].fieldname) : undefined;
    if (duplicate) {
      await client.query('ROLLBACK');
      if (duplicate.bytes !== files[0].size || duplicate.durationSeconds !== metadata[0].durationSeconds) {
        res.status(409).json({error:'This clip ID already belongs to a different recording. Download the pending backup and upload it as a new clip.'}); return;
      }
      res.json({saved:true,id:b.id,interview:publicPayload(existing)}); return;
    }
    if (append && existing) Object.assign(payload, existing);
    if (append && !existing) payload.status = 'partial';
    if ((files.length || previous.length) && b.audioConsent !== true) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Explicit voice recording consent is required.' }); return; }
    if (!append && b.status === 'completed' && !b.story.trim() && !files.some(f=>topic(f.fieldname)!=='reflection') && !previous.some(a=>topic(a.questionKey)!=='reflection')) { await client.query('ROLLBACK'); res.status(400).json({ error: 'A spoken answer or research notes are required.' }); return; }
    for (const file of files) {
      const objectKey = `research/private-interviews/${b.id}/${file.fieldname}-${crypto.randomUUID()}`;
      await uploadToR2(objectKey, file.buffer, file.mimetype);
      uploaded.push({ questionKey: file.fieldname, objectKey, contentType: file.mimetype, bytes: file.size, durationSeconds: metadata.find((m:any)=>m.questionKey===file.fieldname).durationSeconds, captureWarnings: metadata.find((m:any)=>m.questionKey===file.fieldname).captureWarnings || [] });
    }
    payload.audio = [...previous.filter(a=>!uploaded.some(n=>n.questionKey===a.questionKey)), ...uploaded];
    if (!append || !existing) {
      payload.audioConsent = b.audioConsent === true;
      payload.adult = true; payload.consent = true; payload.followupConsent = b.followupConsent === true; payload.quoteConsent = b.quoteConsent === true;
      if (!payload.followupConsent) payload.contact = '';
    }
    payload.analysisStatus = append ? 'needs review' : b.analysisStatus === 'reviewed' ? 'reviewed' : 'needs review';
    if (existing) {
      const result = await client.query('UPDATE research_field_interviews SET payload=$2 WHERE id=$1 RETURNING id', [b.id, JSON.stringify(payload)]);
      if (!result.rows.length) throw Error('Interview no longer exists');
    } else { await client.query('INSERT INTO research_field_interviews(id,payload) VALUES($1,$2)', [b.id, JSON.stringify(payload)]); }
    await client.query('COMMIT'); committed = true;
    for (const audio of previous.filter(a=>uploaded.some(n=>n.questionKey===a.questionKey))) { try { await deleteFromR2(audio.objectKey); } catch { console.error('Private interview replaced audio cleanup requires retry', b.id); } }
    res.status(201).json({ saved: true, id: b.id, interview: publicPayload(payload) });
  } catch {
    if (client && !committed) { try { await client.query('ROLLBACK'); } catch { /* Connection may have closed. */ } }
    client?.release(); client = undefined;
    for (const audio of uploaded) { try { const stored=(await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1',[b.id])).rows[0]?.payload; if (!(stored?.audio||[]).some((a:StoredAudio)=>a.objectKey===audio.objectKey)) await deleteFromR2(audio.objectKey); } catch { console.error('Private interview upload retained pending save verification', b.id); } }
    res.status(503).json({ error: 'Interview and recordings not confirmed saved. Keep this tab open and retry.' });
  } finally { client?.release(); }
}
router.delete('/:id', async (req, res) => {
  if (!uuid.test(String(req.params.id))) { res.sendStatus(400); return; }
  try {
    const result = await pool.query('SELECT payload FROM research_field_interviews WHERE id=$1', [req.params.id]);
    for (const audio of result.rows[0]?.payload.audio || []) { await deleteFromR2(audio.objectKey); }
    await pool.query('DELETE FROM research_field_interviews WHERE id=$1', [req.params.id]); res.json({ deleted: true });
  } catch { res.status(503).json({ error: 'Deletion is incomplete. Retry to remove the interview and private audio.' }); }
});
export default router;
