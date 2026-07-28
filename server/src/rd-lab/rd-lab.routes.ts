import express from "express";
import {
  DataRoomRequest, clearSessionCookie, createSession, getIpAddress, getSessionUser,
  requireDataRoomAuth, setSessionCookie
} from "../services/data-room.service";
import { authenticateFounder } from "./rd-auth.service";
import {
  RD_RESOURCES, RdResource, createRecord, getWp1, listRecords, requireRdFounder,
  summary, updateRecord, updateWp1
} from "./rd-lab.service";
import { pool } from "../storage/postgres.client";
import { calculateProcurementProgress } from "./procurement-progress.service";

const router=express.Router();
const asyncHandler=(fn:(req:DataRoomRequest,res:express.Response)=>Promise<unknown>)=>
  (req:express.Request,res:express.Response,next:express.NextFunction)=>Promise.resolve(fn(req as DataRoomRequest,res)).catch(next);

router.post("/auth/login",asyncHandler(async(req,res)=>{
  const user=await authenticateFounder(req.body?.email,req.body?.password,getIpAddress(req));
  if(!user)return res.status(401).json({status:"error",code:"invalid_credentials",message:"Invalid email or password"});
  await pool.query(`UPDATE data_room.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,[user.id]);
  const session=await createSession(req,user,req.body?.remember_device===true?1000*60*60*24*30:1000*60*60*12);
  setSessionCookie(res,session.token,session.expiresAt);
  return res.json({status:"success",user:{id:user.id,email:user.email,role:user.role},session:{expires_at:session.expiresAt.toISOString()}});
}));
router.get("/auth/session",asyncHandler(async(req,res)=>{
  const session=await getSessionUser(req);if(!session||session.user.role!=="founder_admin")return res.status(401).json({status:"error",code:"unauthenticated",message:"Authentication required"});
  return res.json({status:"success",user:{id:session.user.id,email:session.user.email,role:session.user.role}});
}));
router.post("/auth/logout",requireDataRoomAuth,asyncHandler(async(req,res)=>{
  await pool.query(`UPDATE data_room.sessions SET revoked_at=now() WHERE id=$1`,[req.dataRoomSessionId]);clearSessionCookie(res);return res.json({status:"success"});
}));
router.use(requireDataRoomAuth,(req:DataRoomRequest,res,next)=>{try{requireRdFounder(req.dataRoomUser?.role);next();}catch(error){const e=error as {statusCode?:number;code?:string;message?:string};res.status(e.statusCode??403).json({status:"error",code:e.code,message:e.message});}});
router.get("/work-packages/wp1",asyncHandler(async(_req,res)=>res.json({status:"success",work_package:await getWp1()})));
router.patch("/work-packages/wp1",asyncHandler(async(req,res)=>res.json({status:"success",work_package:await updateWp1(req.body??{},req.dataRoomUser!.id)})));
router.get("/work-packages/wp1/summary",asyncHandler(async(_req,res)=>{const wp=await getWp1();return res.json({status:"success",summary:await summary(wp.id)});}));
router.get("/work-packages/:id/procurement-progress",asyncHandler(async(req,res)=>res.json({
  status:"success",
  procurement_progress:await calculateProcurementProgress(String(req.params.id))
})));
for(const resource of Object.keys(RD_RESOURCES) as RdResource[]){
  router.get(`/${resource}`,asyncHandler(async(req,res)=>{const wp=await getWp1();return res.json({status:"success",[resource]:await listRecords(resource,wp.id,req.query as Record<string,unknown>)});}));
  router.post(`/${resource}`,asyncHandler(async(req,res)=>res.status(201).json({status:"success",record:await createRecord(resource,req.body??{},req.dataRoomUser!.id)})));
  router.patch(`/${resource}/:id`,asyncHandler(async(req,res)=>res.json({status:"success",record:await updateRecord(resource,String(req.params.id),req.body??{},req.dataRoomUser!.id)})));
}
router.use((error:Error&{statusCode?:number;code?:string},_req:express.Request,res:express.Response,next:express.NextFunction)=>{
  if(error.code==="23503")return res.status(400).json({status:"error",code:"invalid_rd_reference",message:"A referenced R&D record does not exist"});
  if(!error.statusCode)return next(error);return res.status(error.statusCode).json({status:"error",code:error.code??"rd_error",message:error.message});
});
export default router;
