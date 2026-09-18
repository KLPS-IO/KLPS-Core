import { canonicalFinance } from "./finance-canonical.service";
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

export const calculateFinancialModel = async ({scenarioKey="base",client}:{scenarioKey?:string;client?:PoolClient}) => canonicalFinance(scenarioKey,client??pool);

export const persistFinancialModelSnapshot = async ({
  scenarioKey = "base",
  userId,
  client
}: {
  scenarioKey?: string;
  userId: string;
  client?: PoolClient;
}): Promise<any> => {
  if(!client){const transaction=await pool.connect();try{await transaction.query('BEGIN');const result=await persistFinancialModelSnapshot({scenarioKey,userId,client:transaction});await transaction.query('COMMIT');return result;}catch(e){await transaction.query('ROLLBACK');throw e;}finally{transaction.release();}}
  const db = getClient(client);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scenarioKey]);
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
  return persistFinancialModelSnapshot({scenarioKey,userId});
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
