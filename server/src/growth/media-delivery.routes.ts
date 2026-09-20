import express from 'express';
import multer from 'multer';
import { DataRoomRequest } from '../services/data-room.service';
import { ensureWorkspace } from './growth.service';
import { pool } from '../storage/postgres.client';
import * as media from './media-delivery.service';
export const publicMediaRoutes=express.Router();
publicMediaRoutes.get('/media-delivery/:token',async(req,res)=>{
 res.set({'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
 try { const body=await media.retrieveDelivery(String(req.params.token)); res.type('image/jpeg').set('Content-Disposition','inline').send(body); }
 catch { res.status(404).end(); }
});
export const privateMediaRoutes=express.Router();
const run=(fn:(req:DataRoomRequest,workspace:string)=>Promise<unknown>):express.RequestHandler=>async(req,res,next)=>{
 try { const r=req as DataRoomRequest; const w=await ensureWorkspace(r.dataRoomUser!.id,pool,r.dataRoomUser!.role); res.json({status:'success',record:await fn(r,w.id)}); } catch(e) { next(e); }
};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8388608,files:1,fields:0}});
privateMediaRoutes.post('/media/:id/publishing-assets',upload.single('file'),run((r,w)=>media.uploadPublishingAsset(w,String(r.params.id),r.file?.buffer??Buffer.alloc(0))));
privateMediaRoutes.post('/publishing-assets/:id/approve',run((r,w)=>{
 if(r.body?.approved!==true) throw Object.assign(new Error('Explicit approval required'),{statusCode:400});
 return media.approvePublishingAsset(w,String(r.params.id),r.dataRoomUser!.id);
}));
privateMediaRoutes.post('/publishing-assets/:id/deliveries',run((r,w)=>media.issueDelivery(w,String(r.params.id),r.body?.provider,pool,r.body?.publish_job_id??null)));
privateMediaRoutes.get('/publishing-assets/:id/deliveries',run((r,w)=>media.deliveryStates(w,String(r.params.id))));
privateMediaRoutes.delete('/media-deliveries/:id',run((r,w)=>media.revokeDelivery(w,String(r.params.id))));
