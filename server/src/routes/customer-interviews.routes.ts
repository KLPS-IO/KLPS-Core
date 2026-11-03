import { Router } from 'express';
import { pool } from '../storage/postgres.client';
import { requireDataRoomAuth, requireAdmin } from '../services/data-room.service';
const router=Router();
router.use(requireDataRoomAuth,requireAdmin);
router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
const fields=['id','createdAt','version','source','relationship','segment','status','story','impact','alternative','gap','outcome','frequency','spend','spendBasis','problem','offer','price','priceResponse','objection','commitment','contact','paymentReference','paidAmount','notes'];
router.get('/',async(_req,res)=>{try{const result=await pool.query('SELECT payload FROM research_field_interviews ORDER BY created_at DESC');res.json({interviews:result.rows.map(r=>r.payload)});}catch{res.status(503).json({error:'Interview storage unavailable; migration and deployment required.'});}});
router.route('/').post(saveInterview).put(saveInterview);
async function saveInterview(req:import('express').Request,res:import('express').Response){const b=req.body;
 if(!b||b.adult!==true||b.consent!==true||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.id)||!['klps-discovery-v1','klps-discovery-v2'].includes(b.version)||!['completed','partial','pilot'].includes(b.status)||typeof b.source!=='string'||!b.source.trim()||typeof b.story!=='string'||(b.status==='completed'&&!b.story.trim())){res.status(400).json({error:'Adult consent, source, valid record and completed story required.'});return;}
 const concept=b.concepts;
 if(!concept||typeof concept!=='object'||Array.isArray(concept)||typeof concept.tested!=='boolean'){res.status(400).json({error:'Invalid concept comparison'});return;}
 const conceptFields=['garment','garmentReason','technology','technologyReason','fabric','fabricReason','style','wardrobe','routine','mainConcern','concernOrigin','insightNeed','insightAction','safetyWords','proofNeeded','burden','ageBand','wearContext','priceBasis'];
 const concepts:Record<string,unknown>={tested:concept.tested};
 for(const key of conceptFields){if(typeof concept[key]!=='string'||concept[key].length>4000){res.status(400).json({error:'Invalid concept field'});return;}concepts[key]=concept[key];}
 for(const key of ['techConcerns','order']){if(!Array.isArray(concept[key])||concept[key].length>30||concept[key].some((v:unknown)=>typeof v!=='string'||v.length>200)){res.status(400).json({error:'Invalid concept choices'});return;}concepts[key]=concept[key];}
 if(b.priceResponse!=='not tested'&&b.priceResponse!=='declined'&&(!b.price||!concept.priceBasis.trim())){res.status(400).json({error:'Define the exact offer and price before recording a price response'});return;}
 const payload:Record<string,unknown>={concepts};for(const key of fields){if(typeof b[key]!=='string'||b[key].length>4000){res.status(400).json({error:`Invalid field: ${key}`});return;}payload[key]=b[key];}
 for(const key of ['spend','price','paidAmount']){if(b[key]!==''&&(!Number.isFinite(Number(b[key]))||Number(b[key])<0)){res.status(400).json({error:'Amounts must be non-negative.'});return;}}
 if(b.commitment==='paid'&&(!b.paymentReference||!(Number(b.paidAmount)>0))){res.status(400).json({error:'Actual payment amount and reference required.'});return;}
 payload.adult=true;payload.consent=true;payload.followupConsent=b.followupConsent===true;payload.quoteConsent=b.quoteConsent===true;if(!payload.followupConsent)payload.contact='';
 try{if(req.method==='PUT'){const updated=await pool.query('UPDATE research_field_interviews SET payload=$2 WHERE id=$1 RETURNING id',[b.id,JSON.stringify(payload)]);if(!updated.rows.length){res.status(404).json({error:'Interview no longer exists'});return;}}else{await pool.query('INSERT INTO research_field_interviews(id,payload) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[b.id,JSON.stringify(payload)]);}res.status(201).json({saved:true,id:b.id});}catch{res.status(503).json({error:'Interview not saved; retry with this tab open.'});}
}
router.delete('/:id',async(req,res)=>{if(!/^[a-f0-9-]{36}$/i.test(String(req.params.id))){res.status(400).json({error:'Invalid ID'});return;}try{await pool.query('DELETE FROM research_field_interviews WHERE id=$1',[req.params.id]);res.json({deleted:true});}catch{res.status(503).json({error:'Deletion failed'});}});
export default router;
