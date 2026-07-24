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

router.use(requireDataRoomAuth, requireGrowthFounder);

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
    res.json({ status: "success", record: await updateGrowthRecord(resource, workspace.id, param(req.params.id), req.body ?? {}) });
  }));
  router.delete(`/${resource}/:id`, asyncHandler(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ status: "success", record: await deleteGrowthRecord(resource, workspace.id, param(req.params.id)) });
  }));
}

router.use((
  error: Error & { statusCode?: number; code?: string },
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (error.code === "23503") {
    return res.status(400).json({ status: "error", code: "invalid_growth_reference", message: "A related Growth OS record does not exist" });
  }
  if (!error.statusCode) return next(error);
  return res.status(error.statusCode).json({ status: "error", code: error.code ?? "growth_error", message: error.message });
});

export default router;
