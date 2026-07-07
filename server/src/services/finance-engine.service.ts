import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type FinanceUserContext = {
  userId: string;
};

type ScenarioRow = {
  id: string;
  key: string;
  name: string;
};

const FINANCE_FIELDS = [
  "id",
  "scenario_id",
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
  "linked_metrics",
  "evidence_summary",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "version",
  "change_reason"
].join(", ");

const toNumber = (value: unknown) => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const getClient = (client?: PoolClient) =>
  client ?? pool;

export const getScenarioByKey = async (
  scenarioKey = "base",
  client?: PoolClient
) => {
  const result = await getClient(client).query(
    `
    SELECT id, key, name
    FROM finance_os.scenarios
    WHERE key = $1
    LIMIT 1
    `,
    [scenarioKey]
  );

  if (result.rows[0]) {
    return result.rows[0] as ScenarioRow;
  }

  const created = await getClient(client).query(
    `
    INSERT INTO finance_os.scenarios (
      key,
      name,
      description,
      status,
      change_reason
    )
    VALUES ($1, $2, $3, 'active', 'Auto-created scenario')
    RETURNING id, key, name
    `,
    [
      scenarioKey,
      scenarioKey
        .split(/[-_]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      `Finance OS ${scenarioKey} scenario`
    ]
  );

  return created.rows[0] as ScenarioRow;
};

export const calculateFinancialModel = async ({
  scenarioKey = "base",
  client
}: {
  scenarioKey?: string;
  client?: PoolClient;
}) => {
  const db = getClient(client);
  const scenario =
    await getScenarioByKey(scenarioKey, client);

  const assumptions = await db.query(
    `
    SELECT ${FINANCE_FIELDS}
    FROM finance_os.assumptions
    WHERE
      (scenario_id = $1 OR scenario_id IS NULL)
      AND status <> 'deprecated'
    ORDER BY category ASC, name ASC
    `,
    [scenario.id]
  );

  const products = await db.query(
    `
    SELECT price, unit_cost, metadata
    FROM finance_os.products
    WHERE scenario_id = $1 OR scenario_id IS NULL
    `,
    [scenario.id]
  );

  const hires = await db.query(
    `
    SELECT annual_salary, status
    FROM finance_os.hires
    WHERE
      (scenario_id = $1 OR scenario_id IS NULL)
      AND status <> 'deferred'
    `,
    [scenario.id]
  );

  const funding = await db.query(
    `
    SELECT amount, status
    FROM finance_os.funding
    WHERE
      (scenario_id = $1 OR scenario_id IS NULL)
      AND status <> 'withdrawn'
    `,
    [scenario.id]
  );

  const assumptionsByMetric =
    assumptions.rows.reduce<Record<string, number>>(
      (metrics, row) => {
        metrics[slugify(row.name)] = toNumber(row.value);
        metrics[`${slugify(row.category)}_total`] =
          (metrics[`${slugify(row.category)}_total`] ?? 0) +
          toNumber(row.value);
        return metrics;
      },
      {}
    );

  const productRevenue =
    products.rows.reduce(
      (total, row) =>
        total +
        toNumber(row.price) *
          toNumber(row.metadata?.annual_units ?? row.metadata?.units ?? 0),
      0
    );

  const productCosts =
    products.rows.reduce(
      (total, row) =>
        total +
        toNumber(row.unit_cost) *
          toNumber(row.metadata?.annual_units ?? row.metadata?.units ?? 0),
      0
    );

  const payroll =
    hires.rows.reduce(
      (total, row) => total + toNumber(row.annual_salary),
      0
    );

  const plannedFunding =
    funding.rows.reduce(
      (total, row) => total + toNumber(row.amount),
      0
    );

  const assumptionRevenue =
    assumptions.rows
      .filter(row => /revenue|sales|income/i.test(row.category))
      .reduce((total, row) => total + toNumber(row.value), 0);

  const assumptionCosts =
    assumptions.rows
      .filter(row => /cost|expense|payroll|manufacturing|opex/i.test(row.category))
      .reduce((total, row) => total + toNumber(row.value), 0);

  const revenue = assumptionRevenue + productRevenue;
  const costs = assumptionCosts + productCosts + payroll;
  const grossProfit = revenue - productCosts;
  const netBurn = Math.max(costs - revenue, 0);
  const runwayMonths =
    netBurn > 0
      ? Math.round((plannedFunding / (netBurn / 12)) * 10) / 10
      : null;

  const averageConfidence =
    assumptions.rows.length > 0
      ? assumptions.rows.reduce(
          (total, row) => total + toNumber(row.confidence_score),
          0
        ) / assumptions.rows.length
      : null;

  return {
    scenario: {
      id: scenario.id,
      key: scenario.key,
      name: scenario.name
    },
    inputs: {
      assumptions: assumptions.rows,
      products: products.rows.length,
      hires: hires.rows.length,
      funding: funding.rows.length
    },
    outputs: {
      revenue,
      costs,
      gross_profit: grossProfit,
      net_burn: netBurn,
      planned_funding: plannedFunding,
      runway_months: runwayMonths,
      average_confidence:
        averageConfidence === null
          ? null
          : Math.round(averageConfidence * 100) / 100,
      metrics: assumptionsByMetric
    }
  };
};

export const persistFinancialModelSnapshot = async ({
  scenarioKey = "base",
  userId,
  client
}: {
  scenarioKey?: string;
  userId: string;
  client?: PoolClient;
}) => {
  const db = getClient(client);
  const model =
    await calculateFinancialModel({
      scenarioKey,
      client
    });

  const versionResult = await db.query(
    `
    SELECT COALESCE(MAX(model_version), 0) + 1 AS next_version
    FROM finance_os.model_snapshots
    WHERE scenario_key = $1
    `,
    [scenarioKey]
  );

  const modelVersion =
    Number(versionResult.rows[0].next_version);

  const snapshot = await db.query(
    `
    INSERT INTO finance_os.model_snapshots (
      scenario_id,
      scenario_key,
      model_version,
      calculation_inputs,
      outputs,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, scenario_id, scenario_key, model_version, calculation_inputs, outputs, created_at, created_by
    `,
    [
      model.scenario.id,
      scenarioKey,
      modelVersion,
      JSON.stringify(model.inputs),
      JSON.stringify(model.outputs),
      userId
    ]
  );

  return {
    ...model,
    snapshot: snapshot.rows[0]
  };
};

export const getLatestFinancialModel = async ({
  scenarioKey = "base",
  userId
}: {
  scenarioKey?: string;
  userId: string;
}) => {
  const latest = await pool.query(
    `
    SELECT id, scenario_id, scenario_key, model_version, calculation_inputs, outputs, created_at, created_by
    FROM finance_os.model_snapshots
    WHERE scenario_key = $1
    ORDER BY model_version DESC
    LIMIT 1
    `,
    [scenarioKey]
  );

  if (latest.rows[0]) {
    return {
      snapshot: latest.rows[0],
      outputs: latest.rows[0].outputs
    };
  }

  return persistFinancialModelSnapshot({
    scenarioKey,
    userId
  });
};

export const logFinanceEvent = async ({
  eventType,
  entityType,
  entityId,
  scenarioId,
  modelSnapshotId,
  summary,
  metadata = {},
  userId,
  client
}: {
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  scenarioId?: string | null;
  modelSnapshotId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  userId: string;
  client?: PoolClient;
}) => {
  await getClient(client).query(
    `
    INSERT INTO finance_os.finance_events (
      event_type,
      entity_type,
      entity_id,
      scenario_id,
      model_snapshot_id,
      summary,
      metadata,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      eventType,
      entityType ?? null,
      entityId ?? null,
      scenarioId ?? null,
      modelSnapshotId ?? null,
      summary,
      JSON.stringify(metadata),
      userId
    ]
  );
};

export const recalculateAndLog = async ({
  scenarioKey = "base",
  eventType,
  entityType,
  entityId,
  summary,
  metadata = {},
  user,
  client
}: {
  scenarioKey?: string;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  user: FinanceUserContext;
  client: PoolClient;
}) => {
  const model =
    await persistFinancialModelSnapshot({
      scenarioKey,
      userId: user.userId,
      client
    });

  await logFinanceEvent({
    eventType,
    entityType,
    entityId,
    scenarioId: model.scenario.id,
    modelSnapshotId: model.snapshot.id,
    summary,
    metadata,
    userId: user.userId,
    client
  });

  if (
    eventType !== "Revenue Forecast Recalculated" &&
    /revenue|forecast|model/i.test(summary)
  ) {
    await logFinanceEvent({
      eventType: "Revenue Forecast Recalculated",
      entityType: "model_snapshot",
      entityId: model.snapshot.id,
      scenarioId: model.scenario.id,
      modelSnapshotId: model.snapshot.id,
      summary: "Financial Engine recalculated persisted model outputs",
      metadata: {
        triggering_event_type: eventType
      },
      userId: user.userId,
      client
    });
  }

  return model;
};
