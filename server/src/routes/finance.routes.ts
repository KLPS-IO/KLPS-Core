import express from "express";
import {
  DataRoomRequest,
  hasAcceptedCurrentNda,
  requireAuthorised,
  requireDataRoomAuth
} from "../services/data-room.service";
import {
  getLatestFinancialModel,
  getScenarioByKey,
  logFinanceEvent,
  recalculateAndLog
} from "../services/finance-engine.service";
import { pool } from "../storage/postgres.client";
import {
  createEvidence,
  getEvidence,
  getEvidenceVersions,
  getLinkedEvidence,
  linkEvidence,
  listEvidence,
  unlinkEvidence,
  updateEvidence
} from "../services/evidence.service";
import {
  getCompany,
  getCompanyEvidence,
  getCompanyHealth,
  getCompanyVersions,
  updateCompany
} from "../services/company.service";

const router = express.Router();

const jsonOk = (
  data: Record<string, unknown> = {}
) => ({
  status: "success",
  ...data
});

const asyncHandler =
  (
    handler: (
      req: DataRoomRequest,
      res: express.Response
    ) => Promise<unknown>
  ) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) =>
      Promise.resolve(
        handler(req as DataRoomRequest, res)
      ).catch(next);

const ndaMiddleware = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const result =
    await hasAcceptedCurrentNda(
      (req as DataRoomRequest).dataRoomUser!.id
    );

  if (!result.accepted) {
    return res.status(403).json({
      status: "error",
      code: "nda_required",
      message: "Current NDA must be accepted",
      nda_version: result.nda?.version ?? null
    });
  }

  next();
};

export const requireFinanceWrite = (
  req: DataRoomRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  if (req.dataRoomUser?.role !== "founder_admin") {
    return res.status(403).json({
      status: "error",
      code: "finance_write_forbidden",
      message: "Founder/admin access is required to edit Finance OS data"
    });
  }

  next();
};

const getScenarioKey = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : "base";

const getParam = (value: unknown) =>
  Array.isArray(value)
    ? value[0]
    : String(value);

const parseJsonObject = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const parseJsonArray = (value: unknown) =>
  Array.isArray(value)
    ? value
    : [];

const requireText = (
  value: unknown,
  field: string
) => {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(
      new Error(`${field} is required`),
      {
        statusCode: 400,
        code: "invalid_finance_payload"
      }
    );
  }

  return value.trim();
};

const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : null;

const optionalNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
};

const assumptionUpdateFields = [
  "name",
  "category",
  "value",
  "unit",
  "confidence_score",
  "confidence_level",
  "source",
  "owner",
  "status",
  "notes",
  "linked_metrics"
];

router.use(
  requireDataRoomAuth,
  requireAuthorised,
  ndaMiddleware
);

router.get("/company", asyncHandler(async (_req, res) => {
  const company = await getCompany();
  const links = await getCompanyEvidence();
  return res.json(jsonOk({ company: { ...company, links } }));
}));

router.patch("/company", requireFinanceWrite, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const company = await updateCompany(req.body ?? {}, req.dataRoomUser!.id, client);
    await client.query("COMMIT");
    return res.json(jsonOk({ company }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

router.get("/company/versions", asyncHandler(async (_req, res) => {
  return res.json(jsonOk({ versions: await getCompanyVersions() }));
}));

router.get("/company/health", asyncHandler(async (_req, res) => {
  return res.json(jsonOk({ health: await getCompanyHealth() }));
}));

router.get("/company/evidence", asyncHandler(async (_req, res) => {
  return res.json(jsonOk({ evidence: await getCompanyEvidence() }));
}));

router.get(
  "/state",
  asyncHandler(async (req, res) => {
    const scenarioKey =
      getScenarioKey(req.query.scenario);
    const scenario =
      await getScenarioByKey(scenarioKey);
    const latestModel =
      await getLatestFinancialModel({
        scenarioKey,
        userId: req.dataRoomUser!.id
      });

    const [
      assumptions,
      evidence,
      decisions,
      risks,
      reports,
      scenarios,
      products,
      hires,
      funding
    ] = await Promise.all([
      pool.query(
        `
        SELECT *
        FROM finance_os.assumptions
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY category ASC, name ASC
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.evidence
        ORDER BY created_at DESC
        LIMIT 100
        `
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.decisions
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY created_at DESC
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.risks
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY created_at DESC
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.reports
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY generated_at DESC
        LIMIT 50
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.scenarios
        ORDER BY created_at ASC
        `
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.products
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY created_at DESC
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.hires
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY created_at DESC
        `,
        [scenario.id]
      ),
      pool.query(
        `
        SELECT *
        FROM finance_os.funding
        WHERE scenario_id = $1 OR scenario_id IS NULL
        ORDER BY created_at DESC
        `,
        [scenario.id]
      )
    ]);

    return res.json(
      jsonOk({
        scenario,
        model: latestModel,
        assumptions: assumptions.rows,
        evidence: evidence.rows,
        decisions: decisions.rows,
        risks: risks.rows,
        reports: reports.rows,
        scenarios: scenarios.rows,
        products: products.rows,
        hires: hires.rows,
        funding: funding.rows
      })
    );
  })
);

router.get(
  "/model",
  asyncHandler(async (req, res) => {
    const scenarioKey =
      getScenarioKey(req.query.scenario);
    const model =
      await getLatestFinancialModel({
        scenarioKey,
        userId: req.dataRoomUser!.id
      });

    return res.json(
      jsonOk({
        model
      })
    );
  })
);

router.patch(
  "/assumptions/:id",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const changeReason =
      requireText(
        req.body?.change_reason,
        "change_reason"
      );
    const scenarioKey =
      getScenarioKey(req.body?.scenario ?? req.query.scenario);
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of assumptionUpdateFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        values.push(
          field === "linked_metrics"
            ? JSON.stringify(parseJsonArray(req.body[field]))
            : req.body[field]
        );
        updates.push(`${field} = $${values.length}`);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        status: "error",
        code: "no_assumption_updates",
        message: "At least one assumption field is required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `
        SELECT *
        FROM finance_os.assumptions
        WHERE id = $1
        FOR UPDATE
        `,
        [req.params.id]
      );

      if (existing.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: "error",
          code: "assumption_not_found",
          message: "Assumption not found"
        });
      }

      const previous = existing.rows[0];
      await client.query(
        `
        INSERT INTO finance_os.assumption_versions (
          assumption_id,
          version,
          snapshot,
          change_reason,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (assumption_id, version)
        DO NOTHING
        `,
        [
          previous.id,
          previous.version,
          JSON.stringify(previous),
          changeReason,
          req.dataRoomUser!.id
        ]
      );

      values.push(
        req.dataRoomUser!.id,
        changeReason,
        req.params.id
      );

      const updated = await client.query(
        `
        UPDATE finance_os.assumptions
        SET
          ${updates.join(", ")},
          updated_by = $${values.length - 2},
          change_reason = $${values.length - 1},
          version = version + 1
        WHERE id = $${values.length}
        RETURNING *
        `,
        values
      );

      const model =
        await recalculateAndLog({
          scenarioKey,
          eventType: "Manufacturing Cost Updated",
          entityType: "assumption",
          entityId: getParam(req.params.id),
          summary: `Updated finance assumption: ${updated.rows[0].name}`,
          metadata: {
            previous_version: previous.version,
            current_version: updated.rows[0].version,
            changed_fields: updates.map(update => update.split(" = ")[0])
          },
          user: {
            userId: req.dataRoomUser!.id
          },
          client
        });

      await client.query("COMMIT");

      return res.json(
        jsonOk({
          assumption: updated.rows[0],
          model
        })
      );
    }
    catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    finally {
      client.release();
    }
  })
);

router.get(
  "/assumptions/:id/versions",
  asyncHandler(async (req, res) => {
    const versions = await pool.query(
      `
      SELECT *
      FROM finance_os.assumption_versions
      WHERE assumption_id = $1
      ORDER BY version DESC
      `,
      [req.params.id]
    );

    return res.json(
      jsonOk({
        versions: versions.rows
      })
    );
  })
);

router.post(
  "/evidence",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const evidence = await createEvidence(
      req.body ?? {},
      req.dataRoomUser!.id
    );
    return res.status(201).json(jsonOk({ evidence }));
  })
);

router.post(
  "/evidence/:id/link",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const link = await linkEvidence(
      getParam(req.params.id),
      req.body ?? {},
      req.dataRoomUser!.id
    );
    return res.status(201).json(jsonOk({ link }));
  })
);

router.get(
  "/evidence",
  asyncHandler(async (req, res) => {
    const evidence = await listEvidence(req.query);
    return res.json(jsonOk({ evidence }));
  })
);

router.get(
  "/evidence/linked/:entityType/:entityId",
  asyncHandler(async (req, res) => {
    const evidence = await getLinkedEvidence(
      req.params.entityType,
      req.params.entityId
    );
    return res.json(jsonOk({ evidence }));
  })
);

router.get(
  "/evidence/:id",
  asyncHandler(async (req, res) => {
    const evidence = await getEvidence(getParam(req.params.id));
    return res.json(jsonOk({ evidence }));
  })
);

router.patch(
  "/evidence/:id",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const evidence = await updateEvidence(
        getParam(req.params.id),
        req.body ?? {},
        req.dataRoomUser!.id,
        client
      );
      await client.query("COMMIT");
      return res.json(jsonOk({ evidence }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/evidence/:id/versions",
  asyncHandler(async (req, res) => {
    const versions = await getEvidenceVersions(getParam(req.params.id));
    return res.json(jsonOk({ versions }));
  })
);

router.delete(
  "/evidence/:id/links/:linkId",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const link = await unlinkEvidence(
      getParam(req.params.id),
      getParam(req.params.linkId)
    );
    return res.json(jsonOk({ link }));
  })
);

router.get(
  "/events",
  asyncHandler(async (_req, res) => {
    const events = await pool.query(
      `
      SELECT *
      FROM finance_os.finance_events
      ORDER BY created_at DESC
      LIMIT 200
      `
    );

    return res.json(
      jsonOk({
        events: events.rows
      })
    );
  })
);

router.get(
  "/decisions",
  asyncHandler(async (req, res) => {
    const scenario =
      await getScenarioByKey(getScenarioKey(req.query.scenario));
    const decisions = await pool.query(
      `
      SELECT *
      FROM finance_os.decisions
      WHERE scenario_id = $1 OR scenario_id IS NULL
      ORDER BY created_at DESC
      `,
      [scenario.id]
    );

    return res.json(
      jsonOk({
        decisions: decisions.rows
      })
    );
  })
);

router.post(
  "/decisions",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const scenario =
      await getScenarioByKey(getScenarioKey(req.body?.scenario));
    const title =
      requireText(req.body?.title, "title");
    const decisionText =
      requireText(req.body?.decision, "decision");
    const changeReason =
      optionalText(req.body?.change_reason) ??
      "Created finance decision";

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const decision = await client.query(
        `
        INSERT INTO finance_os.decisions (
          scenario_id,
          title,
          decision,
          rationale,
          status,
          metadata,
          created_by,
          updated_by,
          change_reason
        )
        VALUES ($1, $2, $3, $4, COALESCE($5, 'open'), $6, $7, $7, $8)
        RETURNING *
        `,
        [
          scenario.id,
          title,
          decisionText,
          optionalText(req.body?.rationale),
          optionalText(req.body?.status),
          JSON.stringify(parseJsonObject(req.body?.metadata)),
          req.dataRoomUser!.id,
          changeReason
        ]
      );

      const model =
        await recalculateAndLog({
          scenarioKey: scenario.key,
          eventType: "Funding Scenario Created",
          entityType: "decision",
          entityId: decision.rows[0].id,
          summary: `Created finance decision: ${title}`,
          user: {
            userId: req.dataRoomUser!.id
          },
          client
        });

      await client.query("COMMIT");

      return res.status(201).json(
        jsonOk({
          decision: decision.rows[0],
          model
        })
      );
    }
    catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    finally {
      client.release();
    }
  })
);

router.get(
  "/risks",
  asyncHandler(async (req, res) => {
    const scenario =
      await getScenarioByKey(getScenarioKey(req.query.scenario));
    const risks = await pool.query(
      `
      SELECT *
      FROM finance_os.risks
      WHERE scenario_id = $1 OR scenario_id IS NULL
      ORDER BY created_at DESC
      `,
      [scenario.id]
    );

    return res.json(
      jsonOk({
        risks: risks.rows
      })
    );
  })
);

router.post(
  "/risks",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const scenario =
      await getScenarioByKey(getScenarioKey(req.body?.scenario));
    const title =
      requireText(req.body?.title, "title");
    const changeReason =
      optionalText(req.body?.change_reason) ??
      "Created finance risk";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const risk = await client.query(
        `
        INSERT INTO finance_os.risks (
          scenario_id,
          title,
          description,
          category,
          likelihood,
          impact,
          mitigation,
          owner,
          status,
          metadata,
          created_by,
          updated_by,
          change_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'open'), $10, $11, $11, $12)
        RETURNING *
        `,
        [
          scenario.id,
          title,
          optionalText(req.body?.description),
          optionalText(req.body?.category),
          optionalNumber(req.body?.likelihood),
          optionalNumber(req.body?.impact),
          optionalText(req.body?.mitigation),
          optionalText(req.body?.owner),
          optionalText(req.body?.status),
          JSON.stringify(parseJsonObject(req.body?.metadata)),
          req.dataRoomUser!.id,
          changeReason
        ]
      );

      const model =
        await recalculateAndLog({
          scenarioKey: scenario.key,
          eventType: "Funding Scenario Created",
          entityType: "risk",
          entityId: risk.rows[0].id,
          summary: `Created finance risk: ${title}`,
          user: {
            userId: req.dataRoomUser!.id
          },
          client
        });

      await client.query("COMMIT");

      return res.status(201).json(
        jsonOk({
          risk: risk.rows[0],
          model
        })
      );
    }
    catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    finally {
      client.release();
    }
  })
);

router.get(
  "/reports",
  asyncHandler(async (req, res) => {
    const scenario =
      await getScenarioByKey(getScenarioKey(req.query.scenario));
    const reports = await pool.query(
      `
      SELECT *
      FROM finance_os.reports
      WHERE scenario_id = $1 OR scenario_id IS NULL
      ORDER BY generated_at DESC
      LIMIT 100
      `,
      [scenario.id]
    );

    return res.json(
      jsonOk({
        reports: reports.rows
      })
    );
  })
);

router.post(
  "/reports/generate",
  requireFinanceWrite,
  asyncHandler(async (req, res) => {
    const scenarioKey =
      getScenarioKey(req.body?.scenario);
    const reportType =
      optionalText(req.body?.report_type) ?? "finance_summary";
    const title =
      optionalText(req.body?.title) ??
      "Finance OS Summary";
    const changeReason =
      optionalText(req.body?.change_reason) ??
      "Generated finance report";

    const latestModel =
      await getLatestFinancialModel({
        scenarioKey,
        userId: req.dataRoomUser!.id
      });
    const snapshot =
      "snapshot" in latestModel
        ? latestModel.snapshot
        : null;

    if (!snapshot?.id) {
      return res.status(409).json({
        status: "error",
        code: "model_snapshot_required",
        message: "A persisted Financial Engine snapshot is required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const report = await client.query(
        `
        INSERT INTO finance_os.reports (
          scenario_id,
          model_snapshot_id,
          report_type,
          title,
          content,
          created_by,
          updated_by,
          change_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
        RETURNING *
        `,
        [
          snapshot.scenario_id,
          snapshot.id,
          reportType,
          title,
          JSON.stringify({
            model_snapshot_id: snapshot.id,
            model_version: snapshot.model_version,
            outputs: latestModel.outputs,
            sections: [
              {
                key: "financial_outputs",
                source: "finance_os.model_snapshots.outputs"
              }
            ]
          }),
          req.dataRoomUser!.id,
          changeReason
        ]
      );

      await logFinanceEvent({
        eventType: "Finance Report Generated",
        entityType: "report",
        entityId: report.rows[0].id,
        scenarioId: snapshot.scenario_id,
        modelSnapshotId: snapshot.id,
        summary: `Generated finance report: ${title}`,
        metadata: {
          report_type: reportType,
          source_model_version: snapshot.model_version
        },
        userId: req.dataRoomUser!.id,
        client
      });

      await client.query("COMMIT");

      return res.status(201).json(
        jsonOk({
          report: report.rows[0]
        })
      );
    }
    catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    finally {
      client.release();
    }
  })
);

router.get(
  "/insights",
  asyncHandler(async (req, res) => {
    const scenarioKey =
      getScenarioKey(req.query.scenario);
    const model =
      await getLatestFinancialModel({
        scenarioKey,
        userId: req.dataRoomUser!.id
      });
    const outputs =
      model.outputs as Record<string, unknown>;

    return res.json(
      jsonOk({
        insights: [
          {
            key: "runway",
            type: "model_signal",
            metric: "runway_months",
            value: outputs.runway_months ?? null,
            source_model_snapshot_id: model.snapshot.id
          },
          {
            key: "confidence",
            type: "model_signal",
            metric: "average_confidence",
            value: outputs.average_confidence ?? null,
            source_model_snapshot_id: model.snapshot.id
          },
          {
            key: "burn",
            type: "model_signal",
            metric: "net_burn",
            value: outputs.net_burn ?? null,
            source_model_snapshot_id: model.snapshot.id
          }
        ]
      })
    );
  })
);

router.use(
  (
    error: Error & {
      statusCode?: number;
      code?: string;
    },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (!error.statusCode) {
      return next(error);
    }

    return res.status(error.statusCode).json({
      status: "error",
      code: error.code ?? "finance_error",
      message: error.message
    });
  }
);

export default router;
