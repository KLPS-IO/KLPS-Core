import express from "express";
import {
  DataRoomRequest,
  requireDataRoomAuth
} from "../services/data-room.service";
import {
  GROWTH_RESOURCES,
  GrowthResource,
  createGrowthRecord,
  deleteGrowthRecord,
  ensureWorkspace,
  getGrowthRecord,
  getMetricsSummary,
  getMissionControl,
  getStrategy,
  listGrowthRecords,
  requireFounderGrowth,
  updateGrowthRecord,
  updateStrategy,
  updateWorkspace
} from "./growth.service";
import {
  changeCommunityStage,
  createFollowUp,
  createInteraction,
  createReferral,
  createTrackedLink,
  deterministicDraft,
  getCommunityPerson,
  getCommunitySummary,
  getCommunityVoice,
  getTractionSummary,
  listCommunityPeople,
  listFollowUps,
  listInteractions,
  listTrackedLinks,
  markCommunityPersonReviewed,
  saveQualification,
  updateCommunityProfile,
  updateFollowUp
} from "./community.service";
import socialRoutes, { socialOAuthCallbackRoutes } from "./social/social.routes";
import {
  acceptMissionCandidate,
  completeMission,
  dismissMissionCandidate
} from "./mission-candidate.service";

const router = express.Router();
const asyncHandler = (handler: (req: DataRoomRequest, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(handler(req as DataRoomRequest, res)).catch(next);

export const requireGrowthFounder = (
  req: DataRoomRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    requireFounderGrowth(req.dataRoomUser?.role);
    next();
  } catch (error) {
    const typed = error as { statusCode?: number; code?: string; message?: string };
    res.status(typed.statusCode ?? 403).json({
      status: "error",
      code: typed.code ?? "growth_forbidden",
      message: typed.message ?? "Founder/admin access is required"
    });
  }
};

// The LinkedIn callback authenticates the single-use state record and its stored
// founder/workspace binding. It deliberately does not depend on a cross-site cookie.
router.use("/social",socialOAuthCallbackRoutes);
router.use(requireDataRoomAuth, requireGrowthFounder);
router.use("/social",socialRoutes);

const workspaceFor = (req: DataRoomRequest) => ensureWorkspace(req.dataRoomUser!.id);
const param = (value: unknown) => Array.isArray(value) ? String(value[0]) : String(value);

router.get("/workspace", asyncHandler(async (req, res) => {
  res.json({ status: "success", workspace: await workspaceFor(req) });
}));

router.patch("/workspace", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", workspace: await updateWorkspace(workspace.id, req.body ?? {}) });
}));

router.get("/strategy", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", strategy: await getStrategy(workspace.id) });
}));

router.patch("/strategy", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", strategy: await updateStrategy(workspace.id, req.body ?? {}) });
}));

router.get("/mission-control", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", mission_control: await getMissionControl(workspace.id) });
}));

router.get("/metrics/summary", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", summary: await getMetricsSummary(workspace.id) });
}));

router.get("/community/summary", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", summary: await getCommunitySummary(workspace.id) });
}));

router.get("/community/people", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", ...(await listCommunityPeople(workspace.id, req.query)) });
}));

router.get("/community/people/:id", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", person: await getCommunityPerson(workspace.id, param(req.params.id)) });
}));

router.post("/community/people/:id/review", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", profile: await markCommunityPersonReviewed(workspace.id, param(req.params.id), req.dataRoomUser!.id) });
}));

router.patch("/community/people/:id", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", profile: await updateCommunityProfile(workspace.id, param(req.params.id), req.body ?? {}) });
}));

router.post("/community/people/:id/stage", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", profile: await changeCommunityStage(workspace.id, param(req.params.id), req.dataRoomUser!.id, req.body ?? {}) });
}));

router.post("/community/people/:id/interactions", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({ status: "success", interaction: await createInteraction(workspace.id, param(req.params.id), req.dataRoomUser!.id, req.body ?? {}) });
}));

router.get("/community/interactions", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", interactions: await listInteractions(workspace.id) });
}));

router.get("/community/follow-ups", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", follow_ups: await listFollowUps(workspace.id) });
}));

router.post("/community/people/:id/follow-ups", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({ status: "success", follow_up: await createFollowUp(workspace.id, param(req.params.id), req.body ?? {}) });
}));

router.patch("/community/follow-ups/:id", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", follow_up: await updateFollowUp(workspace.id, param(req.params.id), req.body ?? {}) });
}));

router.post("/community/people/:id/qualification", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", qualification: await saveQualification(workspace.id, param(req.params.id), req.body ?? {}) });
}));

router.post("/community/people/:id/draft", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  const person = await getCommunityPerson(workspace.id, param(req.params.id));
  res.json({
    status: "success",
    draft: deterministicDraft(String(req.body?.kind ?? "follow_up"), person.name, person.relationship_stage)
  });
}));

router.post("/community/people/:id/referrals", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({ status: "success", referral: await createReferral(workspace.id, param(req.params.id), req.body ?? {}) });
}));

router.get("/community/voice", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", voice: await getCommunityVoice(workspace.id) });
}));

router.get("/tracked-links", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", tracked_links: await listTrackedLinks(workspace.id) });
}));

router.post("/tracked-links", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({ status: "success", tracked_link: await createTrackedLink(workspace.id, req.body ?? {}) });
}));

router.get("/traction/summary", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({ status: "success", summary: await getTractionSummary(workspace.id) });
}));

router.post("/mission-candidates/accept", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({
    status: "success",
    mission: await acceptMissionCandidate(
      workspace.id,
      String(req.body?.candidate_key ?? ""),
      String(req.body?.mission_date ?? "")
    )
  });
}));

router.post("/mission-candidates/dismiss", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.status(201).json({
    status: "success",
    dismissal: await dismissMissionCandidate(
      workspace.id,
      String(req.body?.candidate_key ?? ""),
      String(req.body?.candidate_type ?? ""),
      typeof req.body?.reason === "string" ? req.body.reason : undefined
    )
  });
}));

router.post("/missions/:id/complete", asyncHandler(async (req, res) => {
  const workspace = await workspaceFor(req);
  res.json({
    status: "success",
    ...(await completeMission(
      workspace.id,
      param(req.params.id),
      {
        manual_close: req.body?.manual_close === true,
        manual_close_reason: typeof req.body?.manual_close_reason === "string"
          ? req.body.manual_close_reason
          : undefined
      }
    ))
  });
}));

for (const resource of Object.keys(GROWTH_RESOURCES) as GrowthResource[]) {
  router.get(`/${resource}`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ status: "success", [resource]: await listGrowthRecords(resource, workspace.id, req.query) });
  }));
  router.post(`/${resource}`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.status(201).json({ status: "success", record: await createGrowthRecord(resource, workspace.id, req.body ?? {}) });
  }));
  router.get(`/${resource}/:id`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ status: "success", record: await getGrowthRecord(resource, workspace.id, param(req.params.id)) });
  }));
  router.patch(`/${resource}/:id`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    if (resource === "missions" && req.body?.status === "completed") {
      const completed = await completeMission(
        workspace.id,
        param(req.params.id),
        {
          manual_close: req.body?.manual_close === true,
          manual_close_reason: typeof req.body?.manual_close_reason === "string"
            ? req.body.manual_close_reason
            : undefined
        }
      );
      return res.json({ status: "success", record: completed.mission });
    }
    res.json({ status: "success", record: await updateGrowthRecord(resource, workspace.id, param(req.params.id), req.body ?? {}) });
  }));
  router.delete(`/${resource}/:id`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ status: "success", record: await deleteGrowthRecord(resource, workspace.id, param(req.params.id)) });
  }));
}

router.use((
  error: Error & { statusCode?: number; code?: string; details?: unknown },
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (error.code === "23503") {
    return res.status(400).json({ status: "error", code: "invalid_growth_reference", message: "A related Growth OS record does not exist" });
  }
  if (error.code === "42703" || error.code === "42P01") {
    return res.status(503).json({
      status: "error",
      code: "growth_phase5_migration_required",
      message: "Growth OS is awaiting its Phase 5A database update. No data has been changed."
    });
  }
  if (!error.statusCode) return next(error);
  return res.status(error.statusCode).json({
    status: "error",
    code: error.code ?? "growth_error",
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details })
  });
});

export default router;
