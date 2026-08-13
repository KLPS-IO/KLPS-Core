import express from "express";
import { DataRoomRequest,requireDataRoomAuth,requireAdmin } from "../services/data-room.service";
import { appendRawReadings,completeTestSession,listDevices,listRawReadings,listSessions,listSpecimens,overview,registerDevice,startTestSession } from "./textile-lab.service";

const router=express.Router();
const asyncHandler=(fn:(req:DataRoomRequest,res:express.Response)=>Promise<unknown>)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>Promise.resolve(fn(req as DataRoomRequest,res)).catch(next);
router.use(requireDataRoomAuth,requireAdmin);
router.get("/overview",asyncHandler(async(_req,res)=>res.json({status:"success",overview:await overview()})));
router.get("/devices",asyncHandler(async(_req,res)=>res.json({status:"success",devices:await listDevices()})));
router.post("/devices",asyncHandler(async(req,res)=>res.status(201).json({status:"success",device:await registerDevice(req.body??{},req.dataRoomUser!.id)})));
router.get("/specimens",asyncHandler(async(_req,res)=>res.json({status:"success",specimens:await listSpecimens()})));
router.get("/sessions",asyncHandler(async(_req,res)=>res.json({status:"success",sessions:await listSessions()})));
router.post("/sessions",asyncHandler(async(req,res)=>res.status(201).json({status:"success",session:await startTestSession(req.body??{},req.dataRoomUser!.id)})));
router.post("/sessions/:id/complete",asyncHandler(async(req,res)=>res.json({status:"success",session:await completeTestSession(req.params.id,req.dataRoomUser!.id)})));
router.get("/sessions/:id/readings",asyncHandler(async(req,res)=>res.json({status:"success",readings:await listRawReadings(req.params.id)})));
router.post("/sessions/:id/readings",asyncHandler(async(req,res)=>res.status(201).json({status:"success",readings:await appendRawReadings(req.params.id,req.body?.readings,req.dataRoomUser!.id)})));
router.use((error:Error&{statusCode?:number;code?:string},_req:express.Request,res:express.Response,next:express.NextFunction)=>{if(!error.statusCode)return next(error);return res.status(error.statusCode).json({status:"error",code:error.code,message:error.message});});
export default router;
