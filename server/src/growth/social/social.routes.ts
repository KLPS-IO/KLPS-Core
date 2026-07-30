import express from "express";
import { DataRoomRequest } from "../../services/data-room.service";
import { ensureWorkspace } from "../growth.service";
import { getSocialAdapter } from "./social.registry";
import {
  beginSocialOAuth,
  approveSocialContentVariant,
  completeLinkedInOAuthFromState,
  completeSocialOAuth,
  createPublishJob,
  disconnectSocialProvider,
  getSocialProviderOverview,
  schedulePublishJob,
  upsertSocialContentVariant
} from "./social.service";
import { SocialProvider } from "./social.types";

const router = express.Router();
export const socialOAuthCallbackRoutes = express.Router();
const asyncHandler = (handler: (req: DataRoomRequest, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(handler(req as DataRoomRequest,res)).catch(next);
const workspaceFor = (req: DataRoomRequest) => ensureWorkspace(req.dataRoomUser!.id);
const providerFrom = (value: unknown) => {
  const provider = String(value);
  getSocialAdapter(provider);
  return provider as SocialProvider;
};

const SOCIAL_FRONTEND_ORIGIN = "https://klps.co.uk";
const SOCIAL_FRONTEND_PATH = "/innovation-lab/growth/settings";
const SOCIAL_FAILURE_CODES = {
  social_oauth_provider_error:"access_denied",
  social_oauth_state_required:"invalid_state",
  social_oauth_state_invalid:"invalid_state",
  social_oauth_state_expired:"expired_state",
  social_oauth_code_missing:"missing_code",
  linkedin_token_exchange_failed:"provider_exchange_failed",
  linkedin_identity_lookup_failed:"identity_lookup_failed",
  social_oauth_binding_invalid:"connection_failed",
  social_oauth_callback_failed:"connection_failed"
} as const;

const socialFrontendBase = () => {
  const fallback = new URL(SOCIAL_FRONTEND_PATH,SOCIAL_FRONTEND_ORIGIN);
  const configured = process.env.GROWTH_SOCIAL_FRONTEND_URL?.trim();
  if (!configured) return fallback;
  try {
    const candidate = new URL(configured);
    if (
      candidate.origin !== SOCIAL_FRONTEND_ORIGIN ||
      (candidate.pathname !== "/" && candidate.pathname !== SOCIAL_FRONTEND_PATH) ||
      candidate.username ||
      candidate.password
    ) return fallback;
    return new URL(SOCIAL_FRONTEND_PATH,candidate.origin);
  } catch {
    return fallback;
  }
};

export const buildSocialOAuthRedirect = (
  result: { status:"connected" } | { status:"failed"; code:string }
) => {
  const url = socialFrontendBase();
  url.search = "";
  url.hash = "";
  url.searchParams.set("social_provider","linkedin");
  if (result.status === "connected") {
    url.searchParams.set("social_status","connected");
  } else {
    url.searchParams.set("social_status","failed");
    const code = SOCIAL_FAILURE_CODES[result.code as keyof typeof SOCIAL_FAILURE_CODES] ??
      "connection_failed";
    url.searchParams.set("social_error",code);
  }
  return url.toString();
};

type LinkedInCallbackCompleter = typeof completeLinkedInOAuthFromState;

export const handleLinkedInOAuthCallback = async (
  req: express.Request,
  res: express.Response,
  complete: LinkedInCallbackCompleter = completeLinkedInOAuthFromState
) => {
  try {
    await complete(
      String(req.query.state ?? ""),
      String(req.query.code ?? ""),
      typeof req.query.error === "string" ? req.query.error : undefined
    );
    return res.redirect(303,buildSocialOAuthRedirect({ status:"connected" }));
  } catch (reason) {
    const code = typeof reason === "object" && reason && "code" in reason &&
      typeof reason.code === "string" ? reason.code : "social_oauth_callback_failed";
    const safeCode = SOCIAL_FAILURE_CODES[code as keyof typeof SOCIAL_FAILURE_CODES] ??
      "connection_failed";
    console.warn(JSON.stringify({
      event:"growth_social_oauth_callback_failed",
      provider:"linkedin",
      reason:safeCode
    }));
    return res.redirect(303,buildSocialOAuthRedirect({ status:"failed",code }));
  }
};

socialOAuthCallbackRoutes.get(
  "/oauth/linkedin/callback",
  (req,res,next) => handleLinkedInOAuthCallback(req,res).catch(next)
);

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
