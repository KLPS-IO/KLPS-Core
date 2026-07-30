import express from "express";
import { DataRoomRequest } from "../../services/data-room.service";
import { ensureWorkspace } from "../growth.service";
import { getSocialAdapter } from "./social.registry";
import {
  beginSocialOAuth,
  approveSocialContentVariant,
  completeSocialOAuth,
  createPublishJob,
  disconnectSocialProvider,
  getSocialProviderOverview,
  schedulePublishJob,
  upsertSocialContentVariant
} from "./social.service";
import { SocialProvider } from "./social.types";

const router = express.Router();
const asyncHandler = (handler: (req: DataRoomRequest, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(handler(req as DataRoomRequest,res)).catch(next);
const workspaceFor = (req: DataRoomRequest) => ensureWorkspace(req.dataRoomUser!.id);
const providerFrom = (value: unknown) => {
  const provider = String(value);
  getSocialAdapter(provider);
  return provider as SocialProvider;
};

router.get("/providers", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", providers: await getSocialProviderOverview(workspace.id) });
}));

router.post("/oauth/:provider/start", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    oauth: await beginSocialOAuth(
      workspace.id,req.dataRoomUser!.id,providerFrom(req.params.provider)
    )
  });
}));

router.get("/oauth/:provider/callback", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  const connection = await completeSocialOAuth(
    workspace.id,req.dataRoomUser!.id,providerFrom(req.params.provider),
    String(req.query.state ?? ""),String(req.query.code ?? ""),undefined,
    typeof req.query.error === "string" ? req.query.error : undefined
  );
  res.json({ status: "success", connection });
}));

router.post("/connections/:provider/disconnect", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    connection: await disconnectSocialProvider(
      workspace.id,req.dataRoomUser!.id,providerFrom(req.params.provider)
    )
  });
}));

router.post("/publish-jobs", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({
    status: "success",
    publish_job: await createPublishJob(workspace.id,req.dataRoomUser!.id,req.body ?? {})
  });
}));

router.put("/content/:contentItemId/variants/:provider", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    variant: await upsertSocialContentVariant(
      workspace.id,String(req.params.contentItemId),providerFrom(req.params.provider),req.body ?? {}
    )
  });
}));

router.post("/variants/:id/approve", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    variant: await approveSocialContentVariant(
      workspace.id,req.dataRoomUser!.id,String(req.params.id),req.body ?? {}
    )
  });
}));

router.post("/publish-jobs/:id/schedule", asyncHandler(async (req,res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    publish_job: await schedulePublishJob(
      workspace.id,req.dataRoomUser!.id,String(req.params.id),req.body ?? {}
    )
  });
}));

export default router;
