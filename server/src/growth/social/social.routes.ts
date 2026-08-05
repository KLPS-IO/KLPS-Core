import express from "express";
import { DataRoomRequest } from "../../services/data-room.service";
import { ensureWorkspace } from "../growth.service";
import { getSocialAdapter } from "./social.registry";
import {
  beginSocialOAuth,
  approveSocialContentVariant,
  completeMetaOAuthFromState,
  completeLinkedInOAuthFromState,
  completeTikTokOAuthFromState,
  completeXOAuthFromState,
  completeSocialOAuth,
  createPublishJob,
  disconnectSocialProvider,
  getSocialProviderOverview,
  schedulePublishJob,
  upsertSocialContentVariant
} from "./social.service";
import { SocialProvider } from "./social.types";
import { createMetaOAuthDiagnostics } from "./meta.diagnostics";
import { createXOAuthDiagnostics } from "./x.diagnostics";

const router = express.Router();
export const socialOAuthCallbackRoutes = express.Router();
const asyncHandler = (handler: (req: DataRoomRequest, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(handler(req as DataRoomRequest,res)).catch(next);
const workspaceFor = (req: DataRoomRequest) => ensureWorkspace(req.dataRoomUser!.id,undefined,req.dataRoomUser!.role);
const providerFrom = (value: unknown) => {
  const provider = String(value);
  if (provider === "instagram") throw Object.assign(
    new Error("Instagram Professional accounts are discovered through Meta"),
    {code:"social_provider_discovered_through_meta",statusCode:409}
  );
  getSocialAdapter(provider);
  return provider as SocialProvider;
};

const SOCIAL_FRONTEND_ORIGIN = "https://klps.co.uk";
const SOCIAL_FRONTEND_PATH = "/innovation-lab/funnel/settings";
const SOCIAL_FAILURE_CODES = {
  social_oauth_provider_error:"access_denied",
  social_oauth_state_required:"invalid_state",
  social_oauth_state_invalid:"invalid_state",
  social_oauth_state_expired:"expired_state",
  social_oauth_code_missing:"missing_code",
  linkedin_token_exchange_failed:"provider_exchange_failed",
  linkedin_identity_lookup_failed:"identity_lookup_failed",
  meta_token_exchange_failed:"provider_exchange_failed",
  meta_identity_lookup_failed:"identity_lookup_failed",
  meta_permission_lookup_failed:"permission_lookup_failed",
  meta_page_discovery_failed:"identity_lookup_failed",
  meta_permissions_missing:"permission_lookup_failed",
  meta_asset_persistence_failed:"connection_failed",
  meta_connection_persistence_failed:"connection_failed",
  tiktok_token_exchange_failed:"provider_exchange_failed",
  tiktok_identity_lookup_failed:"identity_lookup_failed",
  tiktok_oauth_not_configured:"connection_failed",
  tiktok_connection_persistence_failed:"connection_failed",
  x_token_exchange_failed:"provider_exchange_failed",
  x_identity_lookup_failed:"identity_lookup_failed",
  x_oauth_not_configured:"connection_failed",
  x_connection_persistence_failed:"connection_failed",
  social_oauth_binding_invalid:"connection_failed",
  social_oauth_callback_failed:"connection_failed"
} as const;

const META_INTERNAL_ERROR_CODES:Record<string,string> = {
  social_oauth_provider_error:"meta_access_denied",
  social_oauth_state_required:"meta_state_invalid",
  social_oauth_state_invalid:"meta_state_invalid",
  social_oauth_state_expired:"meta_state_expired",
  social_oauth_binding_invalid:"meta_state_invalid",
  social_oauth_code_missing:"meta_unexpected_callback_failure",
  meta_oauth_not_configured:"meta_token_exchange_failed",
  meta_token_exchange_failed:"meta_token_exchange_failed",
  meta_identity_lookup_failed:"meta_identity_lookup_failed",
  meta_permission_lookup_failed:"meta_permissions_missing",
  meta_permissions_missing:"meta_permissions_missing",
  meta_page_discovery_failed:"meta_page_discovery_failed",
  meta_asset_persistence_failed:"meta_asset_persistence_failed",
  meta_connection_persistence_failed:"meta_connection_persistence_failed"
};

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
  result: { status:"connected" } | { status:"failed"; code:string },
  provider: "linkedin" | "facebook" | "tiktok" | "x" = "linkedin"
) => {
  const url = socialFrontendBase();
  url.search = "";
  url.hash = "";
  url.searchParams.set("social_provider",provider);
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

router.use((req:DataRoomRequest,res,next)=>{
  if(req.dataRoomUser?.role!=="meta_reviewer")return next();
  const allowed =
    (req.method==="GET" && req.path==="/providers") ||
    (req.method==="POST" && /^\/oauth\/facebook\/start$/.test(req.path)) ||
    (req.method==="POST" && /^\/connections\/facebook\/disconnect$/.test(req.path));
  if(allowed)return next();
  return res.status(403).json({status:"error",code:"reviewer_forbidden",message:"This action is not available in the review workspace"});
});

type LinkedInCallbackCompleter = typeof completeLinkedInOAuthFromState;
type MetaCallbackCompleter = typeof completeMetaOAuthFromState;
type TikTokCallbackCompleter = typeof completeTikTokOAuthFromState;
type XCallbackCompleter = typeof completeXOAuthFromState;

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

export const handleMetaOAuthCallback = async (
  req: express.Request,
  res: express.Response,
  complete: MetaCallbackCompleter = completeMetaOAuthFromState
) => {
  const diagnostics = createMetaOAuthDiagnostics();
  diagnostics.emit("meta_oauth_callback_received",{ stage:"callback_received" });
  try {
    await complete(
      String(req.query.state ?? ""),
      String(req.query.code ?? ""),
      typeof req.query.error === "string" ? req.query.error : undefined,
      undefined,
      diagnostics
    );
    return res.redirect(303,buildSocialOAuthRedirect({ status:"connected" },"facebook"));
  } catch (reason) {
    const code = typeof reason === "object" && reason && "code" in reason &&
      typeof reason.code === "string" ? reason.code : "social_oauth_callback_failed";
    diagnostics.emit("meta_oauth_callback_redirected_with_error",{
      internal_error_code:META_INTERNAL_ERROR_CODES[code] ?? "meta_unexpected_callback_failure",
      stage:"callback_redirect",database_error_category:undefined
    });
    return res.redirect(303,buildSocialOAuthRedirect({ status:"failed",code },"facebook"));
  }
};

export const handleTikTokOAuthCallback = async (
  req:express.Request,
  res:express.Response,
  complete:TikTokCallbackCompleter=completeTikTokOAuthFromState
) => {
  try {
    await complete(
      String(req.query.state ?? ""),
      String(req.query.code ?? ""),
      typeof req.query.error === "string" ? req.query.error : undefined
    );
    return res.redirect(303,buildSocialOAuthRedirect({status:"connected"},"tiktok"));
  } catch (reason) {
    const code=typeof reason === "object" && reason && "code" in reason &&
      typeof reason.code === "string" ? reason.code : "social_oauth_callback_failed";
    const providerErrorCategory=typeof reason === "object" && reason &&
      "providerErrorCategory" in reason && typeof reason.providerErrorCategory === "string"
      ? reason.providerErrorCategory : undefined;
    const providerLogId=typeof reason === "object" && reason && "providerLogId" in reason &&
      typeof reason.providerLogId === "string" ? reason.providerLogId : undefined;
    console.warn(JSON.stringify({
      event:"growth_social_oauth_callback_failed",provider:"tiktok",
      reason:SOCIAL_FAILURE_CODES[code as keyof typeof SOCIAL_FAILURE_CODES] ?? "connection_failed",
      ...(providerErrorCategory ? {provider_error_category:providerErrorCategory} : {}),
      ...(providerLogId ? {provider_log_id:providerLogId} : {})
    }));
    return res.redirect(303,buildSocialOAuthRedirect({status:"failed",code},"tiktok"));
  }
};

export const handleXOAuthCallback = async (
  req:express.Request,
  res:express.Response,
  complete:XCallbackCompleter=completeXOAuthFromState
) => {
  const diagnostics=createXOAuthDiagnostics();
  diagnostics.emit("x_oauth_callback_received",{stage:"callback_received"});
  try {
    await complete(
      String(req.query.state ?? ""),String(req.query.code ?? ""),
      typeof req.query.error === "string" ? req.query.error : undefined,
      undefined,diagnostics
    );
    diagnostics.emit("x_oauth_callback_redirected",{stage:"completed"});
    return res.redirect(303,buildSocialOAuthRedirect({status:"connected"},"x"));
  } catch (reason) {
    const code=typeof reason === "object" && reason && "code" in reason &&
      typeof reason.code === "string" ? reason.code : "social_oauth_callback_failed";
    const safeCode=SOCIAL_FAILURE_CODES[code as keyof typeof SOCIAL_FAILURE_CODES] ??
      "connection_failed";
    diagnostics.emit("x_oauth_callback_redirected_with_error",{
      stage:safeCode === "identity_lookup_failed" ? "identity_lookup"
        : safeCode === "provider_exchange_failed" ? "token_exchange" : "callback"
    });
    return res.redirect(303,buildSocialOAuthRedirect({status:"failed",code},"x"));
  }
};

socialOAuthCallbackRoutes.get(
  "/oauth/linkedin/callback",
  (req,res,next) => handleLinkedInOAuthCallback(req,res).catch(next)
);

socialOAuthCallbackRoutes.get(
  "/oauth/facebook/callback",
  (req,res,next) => handleMetaOAuthCallback(req,res).catch(next)
);

socialOAuthCallbackRoutes.get(
  "/oauth/tiktok/callback",
  (req,res,next) => handleTikTokOAuthCallback(req,res).catch(next)
);

socialOAuthCallbackRoutes.get(
  "/oauth/x/callback",
  (req,res,next) => handleXOAuthCallback(req,res).catch(next)
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
