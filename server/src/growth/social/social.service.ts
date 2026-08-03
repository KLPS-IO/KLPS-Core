import { PoolClient } from "pg";
import { pool } from "../../storage/postgres.client";
import {
  createPkceChallenge,
  decryptSocialSecret,
  encryptSocialSecret,
  fingerprintSocialContent,
  generateOAuthState,
  generatePkceVerifier,
  hashOAuthState
} from "./social.crypto";
import { getSocialAdapter, listSocialAdapters, validateSocialEnvironment } from "./social.registry";
import { MetaGrantMode, MetaOAuthDiagnostics, SocialCapability, SocialProvider } from "./social.types";
import { getFacebookBusinessConfigurationStatus, safeDatabaseErrorCategory } from "./meta.diagnostics";

type Db = Pick<PoolClient, "query">;
type Input = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const socialError = (message: string, code = "invalid_social_request", statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
const uuid = (value: unknown, field: string) => {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw socialError(`${field} must be a UUID`);
  return value;
};
const safeText = (value: unknown, field: string, limit = 1000) => {
  if (typeof value !== "string" || !value.trim()) throw socialError(`${field} is required`);
  return value.trim().slice(0, limit);
};

const inTransaction = async <T>(db: Db, work: (transaction: Db) => Promise<T>) => {
  const transactional = db as Db & { connect?: () => Promise<PoolClient> };
  if (typeof transactional.connect !== "function") return work(db);
  const client = await transactional.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (reason) {
    await client.query("ROLLBACK");
    throw reason;
  } finally {
    client.release();
  }
};

export const getSocialProviderOverview = async (workspaceId: string, db: Db = pool) => {
  const connectionResult = await db.query(`
    SELECT id,provider,provider_account_name,provider_account_type,status,granted_scopes,
      discovered_capabilities,last_successful_check_at,last_error_code,last_error_at,
      connected_at,token_expires_at
    FROM growth_os.social_connections WHERE workspace_id=$1
  `, [workspaceId]);
  const assetResult = await db.query(`
    SELECT social_connection_id,provider,provider_asset_type,provider_asset_id,
      provider_asset_name,provider_asset_username,status,discovered_at,updated_at
    FROM growth_os.social_connection_assets
    WHERE workspace_id=$1
    ORDER BY provider_asset_type,provider_asset_name,provider_asset_id
  `, [workspaceId]);
  const assetsByConnection = new Map<string, unknown[]>();
  for (const asset of assetResult.rows) {
    const current = assetsByConnection.get(asset.social_connection_id) ?? [];
    current.push(asset);
    assetsByConnection.set(asset.social_connection_id,current);
  }
  const connections = new Map(connectionResult.rows.map(row => [row.provider, {
    ...row,
    assets: assetsByConnection.get(row.id) ?? []
  }]));
  return listSocialAdapters().map(adapter => {
    const definition = adapter.definition;
    const environment = validateSocialEnvironment(definition.id);
    const configuredNames = new Set(definition.requiredEnvironment.filter(name => process.env[name]?.trim()));
    const providerActivated = ["linkedin","facebook","tiktok"].includes(definition.id) && environment.available;
    return {
      provider: definition.id,
      name: definition.name,
      connection: connections.get(definition.id) ?? null,
      availability: environment,
      required_permissions: definition.scopes,
      future_permissions: definition.futurePermissions ?? [],
      capabilities: definition.capabilities,
      approval_required: !providerActivated,
      ...(definition.id === "facebook" ? {
        facebook_business_configuration: (() => {
          const status=getFacebookBusinessConfigurationStatus();
          return {
            config_id_configured:status.configured,
            mode:status.active ? "active" : "inactive",
            config_id_valid:status.valid,
            config_id_fingerprint:status.fingerprint
          };
        })()
      } : {}),
      setup_checklist: [
        {
          label: "Developer account",
          detail: definition.developerAccount,
          status: providerActivated ? "configured" : "required"
        },
        {
          label: "Application",
          detail: definition.applicationName,
          status: providerActivated ? "configured" : "required"
        },
        ...definition.requiredEnvironment.map(name => ({
          label: name,
          detail: name.endsWith("REDIRECT_URI")
            ? `Set this to the production backend origin plus /api/growth/social/oauth/${definition.id}/callback, and register that exact URL with ${definition.name}.`
            : "Configure this only in the backend production environment.",
          status: configuredNames.has(name) ? "configured" : "required"
        })),
        ...definition.externalReview.map(detail => ({
          label: "Provider approval",
          detail,
          status: definition.futureReady ? "future"
            : definition.futurePermissions?.length ? "external_review"
              : providerActivated ? "configured" : "external_review"
        }))
      ]
    };
  });
};

const audit = async (
  workspaceId: string,
  userId: string | null,
  provider: string | null,
  eventType: string,
  outcome: "started" | "success" | "failure" | "blocked",
  details: Record<string, unknown>,
  db: Db
) => {
  const forbidden = ["token","secret","code","verifier","email","phone"];
  const safeDetails = Object.fromEntries(Object.entries(details).filter(([key]) =>
    !forbidden.some(term => key.toLowerCase().includes(term))
  ));
  await db.query(`
    INSERT INTO growth_os.social_audit_events(
      workspace_id,actor_user_id,provider,event_type,outcome,safe_details
    ) VALUES($1,$2,$3,$4,$5,$6)
  `, [workspaceId,userId,provider,eventType,outcome,safeDetails]);
};

export const beginSocialOAuth = async (
  workspaceId: string,
  userId: string,
  provider: SocialProvider,
  db: Db = pool
) => {
  const adapter = getSocialAdapter(provider);
  const environmentStatus = validateSocialEnvironment(provider);
  if (!environmentStatus.available) {
    await audit(workspaceId,userId,provider,"oauth_start","blocked",{ missing_environment: environmentStatus.missing_environment },db);
    throw socialError(
      `${adapter.definition.name} cannot connect yet. Missing: ${environmentStatus.missing_environment.join(", ") || "provider activation"}`,
      "social_provider_unavailable",
      409
    );
  }
  const environment = adapter.getEnvironment();
  const redirectUri = environment.redirectUri!;
  const state = generateOAuthState();
  const verifier = adapter.definition.supportsPkce ? generatePkceVerifier() : null;
  const challenge = verifier ? createPkceChallenge(verifier) : undefined;
  const grantMode:MetaGrantMode = provider === "facebook" &&
    getFacebookBusinessConfigurationStatus().active
    ? "business_configuration" : "explicit_scope";
  const authorizationUrl=adapter.buildAuthorizationUrl({ state, codeChallenge: challenge, redirectUri });
  const requestedScopes=provider === "facebook"
    ? [...adapter.definition.scopes,`__grant_mode:${grantMode}`]
    : adapter.definition.scopes;
  await db.query(`
    INSERT INTO growth_os.social_oauth_authorisations(
      workspace_id,provider,state_hash,encrypted_code_verifier,redirect_uri,
      requested_scopes,initiated_by,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')
  `, [
    workspaceId,provider,hashOAuthState(state),
    verifier ? encryptSocialSecret(verifier) : null,
    redirectUri,requestedScopes,userId
  ]);
  await db.query(`
    INSERT INTO growth_os.social_connections(workspace_id,provider,status)
    VALUES($1,$2,'connecting')
    ON CONFLICT(workspace_id,provider) DO UPDATE SET
      status=CASE
        WHEN growth_os.social_connections.encrypted_access_token IS NULL THEN 'connecting'
        ELSE growth_os.social_connections.status
      END,
      last_error_code=NULL,last_error_at=NULL
  `, [workspaceId,provider]);
  await audit(workspaceId,userId,provider,"oauth_start","started",{
    redirect_host:new URL(redirectUri).host,
    ...(provider === "facebook" ? { grant_mode:grantMode } : {})
  },db);
  return {
    authorization_url:authorizationUrl,
    expires_in_seconds: 600
  };
};

export const completeSocialOAuth = async (
  workspaceId: string,
  userId: string,
  provider: SocialProvider,
  state: string,
  code: string,
  db: Db = pool,
  providerError?: string
) => {
  if (!state) throw socialError("OAuth state is required", "social_oauth_state_required");
  const authorisation = await db.query(`
    UPDATE growth_os.social_oauth_authorisations
    SET consumed_at=now()
    WHERE workspace_id=$1 AND provider=$2 AND state_hash=$3
      AND consumed_at IS NULL AND expires_at>now()
    RETURNING *
  `, [workspaceId,provider,hashOAuthState(state)]);
  if (!authorisation.rows[0]) {
    await audit(workspaceId,userId,provider,"oauth_callback","blocked",{ reason: "invalid_expired_or_replayed_state" },db);
    throw socialError("OAuth state is invalid, expired or already used", "social_oauth_state_invalid", 409);
  }
  return completeSocialOAuthForAuthorisation({
    ...authorisation.rows[0],
    workspace_id:workspaceId,
    initiated_by:userId
  },provider,code,providerError,db);
};

type OAuthAuthorisationRow = {
  workspace_id: string;
  initiated_by: string;
  redirect_uri: string;
  encrypted_code_verifier: string | null;
  requested_scopes?: string[];
};

const grantModeFromAuthorisation = (row: OAuthAuthorisationRow):MetaGrantMode => {
  const marker=row.requested_scopes?.find(scope => scope.startsWith("__grant_mode:"));
  if (!marker || marker === "__grant_mode:explicit_scope") return "explicit_scope";
  if (marker === "__grant_mode:business_configuration") return "business_configuration";
  throw socialError("OAuth grant mode is invalid","social_oauth_state_invalid",409);
};

const withMetaGrantContext = (
  diagnostics:MetaOAuthDiagnostics | undefined,
  grantMode:MetaGrantMode
):MetaOAuthDiagnostics | undefined => diagnostics && ({
  correlationId:diagnostics.correlationId,
  emit:(event,details={}) => diagnostics.emit(event,{
    ...details,grant_mode:grantMode,
    config_id_configured:grantMode === "business_configuration"
  })
});

const invalidState = (message = "OAuth state is invalid, expired or already used") =>
  socialError(message, "social_oauth_state_invalid", 409);

const diagnoseProviderStateFailure = async (
  stateHash: string,
  provider: SocialProvider,
  db: Db,
  diagnostics?: MetaOAuthDiagnostics
): Promise<never> => {
  const result = await db.query(`
    SELECT
      a.provider,
      a.expires_at <= now() AS expired,
      a.consumed_at IS NOT NULL AS consumed,
      w.id IS NOT NULL AS workspace_exists,
      u.id IS NOT NULL AS initiator_exists,
      u.role,
      w.owner_user_id = a.initiated_by AS initiator_owns_workspace
    FROM growth_os.social_oauth_authorisations a
    LEFT JOIN growth_os.workspaces w ON w.id=a.workspace_id
    LEFT JOIN data_room.users u ON u.id=a.initiated_by
    WHERE a.state_hash=$1
    LIMIT 1
  `, [stateHash]);
  const row = result.rows[0];
  if (!row || row.provider !== provider) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_state_invalid",stage:"state_validation"
    });
    throw invalidState();
  }
  if (row.expired) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_state_expired",stage:"state_validation"
    });
    throw socialError("OAuth state has expired", "social_oauth_state_expired", 409);
  }
  if (row.consumed) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_state_invalid",stage:"state_validation"
    });
    throw invalidState();
  }
  if (
    !row.workspace_exists ||
    !row.initiator_exists ||
    !["founder_admin","meta_reviewer"].includes(row.role) ||
    !row.initiator_owns_workspace
  ) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_state_invalid",stage:"state_validation"
    });
    throw socialError(
      "OAuth founder or workspace binding is no longer authorised",
      "social_oauth_binding_invalid",
      403
    );
  }
  // A concurrent request may have consumed the row between the UPDATE and this
  // diagnostic read. Never permit a second exchange.
  throw invalidState();
};

export const completeSocialOAuthFromState = async (
  provider: SocialProvider,
  state: string,
  code: string,
  providerError?: string,
  db: Db = pool,
  diagnostics?: MetaOAuthDiagnostics
) => {
  if (!state) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_state_invalid",stage:"state_validation"
    });
    throw socialError("OAuth state is required", "social_oauth_state_required");
  }
  const stateHash = hashOAuthState(state);
  const authorisation = await db.query(`
    UPDATE growth_os.social_oauth_authorisations a
    SET consumed_at=now()
    FROM growth_os.workspaces w
    JOIN data_room.users u ON u.id=w.owner_user_id
    WHERE a.provider=$2
      AND a.state_hash=$1
      AND a.consumed_at IS NULL
      AND a.expires_at>now()
      AND w.id=a.workspace_id
      AND w.owner_user_id=a.initiated_by
      AND u.id=a.initiated_by
      AND u.role IN ('founder_admin','meta_reviewer')
    RETURNING
      a.workspace_id,
      a.initiated_by,
      a.redirect_uri,
      a.encrypted_code_verifier,
      a.requested_scopes
  `, [stateHash,provider]);
  const row = authorisation.rows[0] as OAuthAuthorisationRow | undefined;
  if (!row) await diagnoseProviderStateFailure(stateHash,provider,db,diagnostics);
  const callbackDiagnostics=provider === "facebook"
    ? withMetaGrantContext(diagnostics,grantModeFromAuthorisation(row!))
    : diagnostics;
  callbackDiagnostics?.emit("meta_oauth_state_validated",{ stage:"state_validation" });
  return completeSocialOAuthForAuthorisation(
    row!,provider,code,providerError,db,callbackDiagnostics
  );
};

export const completeLinkedInOAuthFromState = (
  state: string,
  code: string,
  providerError?: string,
  db: Db = pool
) => completeSocialOAuthFromState("linkedin",state,code,providerError,db);

export const completeMetaOAuthFromState = (
  state: string,
  code: string,
  providerError?: string,
  db: Db = pool,
  diagnostics?: MetaOAuthDiagnostics
) => completeSocialOAuthFromState("facebook",state,code,providerError,db,diagnostics);

export const completeTikTokOAuthFromState = (
  state: string,
  code: string,
  providerError?: string,
  db: Db = pool
) => completeSocialOAuthFromState("tiktok",state,code,providerError,db);

const completeSocialOAuthForAuthorisation = async (
  row: OAuthAuthorisationRow,
  provider: SocialProvider,
  code: string,
  providerError: string | undefined,
  db: Db,
  diagnostics?: MetaOAuthDiagnostics
) => {
  const workspaceId = row.workspace_id;
  const userId = row.initiated_by;
  const adapter = getSocialAdapter(provider);
  const verifier = row.encrypted_code_verifier ? decryptSocialSecret(row.encrypted_code_verifier) : undefined;
  if (providerError) {
    diagnostics?.emit("meta_oauth_state_rejected",{
      internal_error_code:"meta_access_denied",stage:"provider_authorization"
    });
    await db.query(`
      UPDATE growth_os.social_connections
      SET status=CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END,
        last_error_code='provider_authorization_failed',last_error_at=now()
      WHERE workspace_id=$1 AND provider=$2
    `, [workspaceId,provider]);
    await audit(workspaceId,userId,provider,"oauth_callback","failure",{ reason: "provider_authorization_failed" },db);
    throw socialError(`${adapter.definition.name} authorisation was not completed`, "social_oauth_provider_error");
  }
  if (!code) {
    diagnostics?.emit("meta_oauth_code_exchange_failed",{
      internal_error_code:"meta_unexpected_callback_failure",stage:"code_exchange"
    });
    await db.query(`
      UPDATE growth_os.social_connections
      SET status=CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END,
        last_error_code='missing_authorization_code',last_error_at=now()
      WHERE workspace_id=$1 AND provider=$2
    `, [workspaceId,provider]);
    await audit(workspaceId,userId,provider,"oauth_callback","failure",{ reason: "missing_authorization_code" },db);
    throw socialError("OAuth authorisation code is required", "social_oauth_code_missing");
  }
  try {
    const token = await adapter.exchangeAuthorizationCode({
      code,codeVerifier:verifier,redirectUri:row.redirect_uri,diagnostics
    });
    const assets = token.discoveredAssets.map(asset => ({
      provider:asset.provider,
      provider_asset_type:asset.providerAssetType,
      provider_asset_id:asset.providerAssetId,
      provider_asset_name:asset.providerAssetName,
      provider_asset_username:asset.providerAssetUsername
    }));
    const persistence:{ stage:"connection_persistence" | "asset_persistence" } = {
      stage:"connection_persistence"
    };
    try {
      const connection = await inTransaction(db,async transaction => {
        const result = await transaction.query(`
      INSERT INTO growth_os.social_connections(
        workspace_id,provider,provider_account_id,provider_account_name,provider_account_type,status,
        encrypted_access_token,encrypted_refresh_token,token_expires_at,
        granted_scopes,discovered_capabilities,last_successful_check_at,
        connected_by,connected_at
      ) VALUES($1,$2,$3,$4,$5,'connected',$6,$7,$8,$9,$10,now(),$11,now())
      ON CONFLICT(workspace_id,provider) DO UPDATE SET
        provider_account_id=EXCLUDED.provider_account_id,
        provider_account_name=EXCLUDED.provider_account_name,
        provider_account_type=EXCLUDED.provider_account_type,
        status='connected',
        encrypted_access_token=EXCLUDED.encrypted_access_token,
        encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
        token_expires_at=EXCLUDED.token_expires_at,
        granted_scopes=EXCLUDED.granted_scopes,
        discovered_capabilities=EXCLUDED.discovered_capabilities,
        last_successful_check_at=now(),connected_by=EXCLUDED.connected_by,
        connected_at=now(),revoked_at=NULL,last_error_code=NULL,last_error_at=NULL
      RETURNING id,provider,status,provider_account_name,provider_account_type,granted_scopes,
        discovered_capabilities,last_successful_check_at,connected_at
    `, [
        workspaceId,provider,token.providerAccountId,token.providerAccountName,token.providerAccountType,
        encryptSocialSecret(token.accessToken),
        token.refreshToken ? encryptSocialSecret(token.refreshToken) : null,
        token.expiresAt?.toISOString() ?? null,token.scopes,token.discoveredCapabilities,userId
      ]);
        const connection = result.rows[0];
        persistence.stage="asset_persistence";
        diagnostics?.emit("meta_oauth_asset_persistence_started",{
          stage:"asset_persistence",
          page_found:assets.some(asset => asset.provider === "facebook"),
          instagram_found:assets.some(asset => asset.provider === "instagram")
        });
        await transaction.query(`
        DELETE FROM growth_os.social_connection_assets
        WHERE workspace_id=$1 AND social_connection_id=$2
      `,[workspaceId,connection.id]);
        if (assets.length) await transaction.query(`
        INSERT INTO growth_os.social_connection_assets(
          workspace_id,social_connection_id,provider,provider_asset_type,
          provider_asset_id,provider_asset_name,provider_asset_username,status,
          discovered_at,updated_at
        )
        SELECT $1,$2,a.provider,a.provider_asset_type,a.provider_asset_id,
          a.provider_asset_name,a.provider_asset_username,'active',now(),now()
        FROM jsonb_to_recordset($3::jsonb) AS a(
          provider text,provider_asset_type text,provider_asset_id text,
          provider_asset_name text,provider_asset_username text
        )
        ON CONFLICT(social_connection_id,provider,provider_asset_type,provider_asset_id)
        DO UPDATE SET provider_asset_name=EXCLUDED.provider_asset_name,
          provider_asset_username=EXCLUDED.provider_asset_username,
          status='active',discovered_at=now(),updated_at=now()
      `,[workspaceId,connection.id,JSON.stringify(assets)]);
        await audit(workspaceId,userId,provider,"oauth_callback","success",{},transaction);
        return connection;
      });
      diagnostics?.emit("meta_oauth_connection_completed",{
        stage:"completed",
        page_found:assets.some(asset => asset.provider === "facebook"),
        instagram_found:assets.some(asset => asset.provider === "instagram")
      });
      return connection;
    } catch (reason) {
      const internalCode = provider === "tiktok"
        ? "tiktok_connection_persistence_failed"
        : persistence.stage === "asset_persistence"
          ? "meta_asset_persistence_failed" : "meta_connection_persistence_failed";
      diagnostics?.emit(
        persistence.stage === "asset_persistence"
          ? "meta_oauth_asset_persistence_failed"
          : "meta_oauth_connection_persistence_failed",
        {
          internal_error_code:internalCode,stage:persistence.stage,
          database_error_category:safeDatabaseErrorCategory(reason),
          page_found:assets.some(asset => asset.provider === "facebook"),
          instagram_found:assets.some(asset => asset.provider === "instagram")
        }
      );
      throw Object.assign(reason instanceof Error ? reason : new Error("Social connection persistence failed"),{
        code:internalCode
      });
    }
  } catch (reason) {
    const errorCode = typeof reason === "object" && reason && "code" in reason &&
      typeof reason.code === "string" && /^(?:linkedin|meta|tiktok)_[a-z_]+$/.test(reason.code)
      ? reason.code
      : "social_oauth_callback_failed";
    await db.query(`
      UPDATE growth_os.social_connections
      SET status=CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END,
        last_error_code=$3,last_error_at=now()
      WHERE workspace_id=$1 AND provider=$2
    `, [workspaceId,provider,errorCode]);
    await audit(workspaceId,userId,provider,"oauth_callback","failure",{ reason:errorCode },db);
    throw reason;
  }
};

export const disconnectSocialProvider = async (
  workspaceId: string,
  userId: string,
  provider: SocialProvider,
  db: Db = pool
) => {
  return inTransaction(db,async transaction => {
    const result = await transaction.query(`
      UPDATE growth_os.social_connections SET
        status='revoked',encrypted_access_token=NULL,encrypted_refresh_token=NULL,
        token_expires_at=NULL,granted_scopes='{}',discovered_capabilities='{}',
        revoked_at=now()
      WHERE workspace_id=$1 AND provider=$2
      RETURNING id,provider,status,revoked_at
    `, [workspaceId,provider]);
    if (!result.rows[0]) throw socialError("Social connection not found", "social_connection_not_found", 404);
    await transaction.query(`
      DELETE FROM growth_os.social_connection_assets
      WHERE workspace_id=$1 AND social_connection_id=$2
    `,[workspaceId,result.rows[0].id]);
    await audit(workspaceId,userId,provider,"connection_disconnect","success",{},transaction);
    return result.rows[0];
  });
};

export type PublishReadiness = {
  copyApproved: boolean;
  mediaApproved: boolean;
  destinationValid: boolean;
  connected: boolean;
  healthy: boolean;
  requiredCapabilities: SocialCapability[];
  availableCapabilities: SocialCapability[];
};

export const validatePublishReadiness = (input: PublishReadiness) => {
  const missing: string[] = [];
  if (!input.copyApproved) missing.push("copy approval");
  if (!input.mediaApproved) missing.push("media approval");
  if (!input.destinationValid) missing.push("valid destination");
  if (!input.connected) missing.push("platform connection");
  if (!input.healthy) missing.push("healthy connection");
  for (const capability of input.requiredCapabilities)
    if (!input.availableCapabilities.includes(capability)) missing.push(`capability:${capability}`);
  return { ready: missing.length === 0, missing };
};

export const approvalMustReset = (approvedFingerprint: string | null, currentValue: unknown) =>
  !approvedFingerprint || approvedFingerprint !== fingerprintSocialContent(currentValue);

const variantContent = (copy: string | null, media: unknown[], destination: string | null) => ({
  copy,media,destination
});

export const upsertSocialContentVariant = async (
  workspaceId: string,
  contentItemIdValue: string,
  provider: SocialProvider,
  input: Input,
  db: Db = pool
) => {
  const contentItemId = uuid(contentItemIdValue,"content_item_id");
  const copy = input.copy === null || input.copy === undefined ? null : safeText(input.copy,"copy",10000);
  if (!Array.isArray(input.media_references ?? [])) throw socialError("media_references must be an array");
  const media = input.media_references ?? [];
  const destination = input.destination_reference === null || input.destination_reference === undefined
    ? null : safeText(input.destination_reference,"destination_reference",1000);
  const required: SocialCapability[] = [];
  if (copy) required.push("text");
  for (const item of media as Array<Record<string,unknown>>) {
    if (item?.type === "image" && !required.includes("images")) required.push("images");
    if (item?.type === "video" && !required.includes("video")) required.push("video");
  }
  const available = getSocialAdapter(provider).definition.capabilities;
  const unsupported = required.filter(capability => !available.includes(capability));
  if (unsupported.length) throw socialError(
    `${getSocialAdapter(provider).definition.name} does not support: ${unsupported.join(", ")}`,
    "social_capability_unsupported",
    409
  );
  const fingerprint = fingerprintSocialContent(variantContent(copy,media as unknown[],destination));
  const result = await db.query(`
    INSERT INTO growth_os.social_content_variants(
      workspace_id,content_item_id,provider,copy,media_references,destination_reference
    )
    SELECT $1,c.id,$3,$4,$5,$6
    FROM growth_os.content_items c WHERE c.id=$2 AND c.workspace_id=$1
    ON CONFLICT(workspace_id,content_item_id,provider) DO UPDATE SET
      copy=EXCLUDED.copy,media_references=EXCLUDED.media_references,
      destination_reference=EXCLUDED.destination_reference,
      copy_approved_at=CASE WHEN growth_os.social_content_variants.approval_fingerprint=$7
        THEN growth_os.social_content_variants.copy_approved_at ELSE NULL END,
      media_approved_at=CASE WHEN growth_os.social_content_variants.approval_fingerprint=$7
        THEN growth_os.social_content_variants.media_approved_at ELSE NULL END,
      approved_by=CASE WHEN growth_os.social_content_variants.approval_fingerprint=$7
        THEN growth_os.social_content_variants.approved_by ELSE NULL END,
      approval_fingerprint=CASE WHEN growth_os.social_content_variants.approval_fingerprint=$7
        THEN growth_os.social_content_variants.approval_fingerprint ELSE NULL END
    RETURNING *
  `, [workspaceId,contentItemId,provider,copy,media,destination,fingerprint]);
  if (!result.rows[0]) throw socialError("Studio content item not found in this workspace","social_content_not_found",404);
  return result.rows[0];
};

export const approveSocialContentVariant = async (
  workspaceId: string,
  userId: string,
  variantIdValue: string,
  input: Input,
  db: Db = pool
) => {
  const variantId = uuid(variantIdValue,"variant_id");
  if (typeof input.copy_approved !== "boolean" || typeof input.media_approved !== "boolean")
    throw socialError("copy_approved and media_approved must be explicit booleans");
  const current = await db.query(`
    SELECT * FROM growth_os.social_content_variants WHERE id=$1 AND workspace_id=$2
  `,[variantId,workspaceId]);
  const variant = current.rows[0];
  if (!variant) throw socialError("Social content variant not found","social_variant_not_found",404);
  const fingerprint = fingerprintSocialContent(
    variantContent(variant.copy,variant.media_references,variant.destination_reference)
  );
  const result = await db.query(`
    UPDATE growth_os.social_content_variants SET
      copy_approved_at=CASE WHEN $3 THEN now() ELSE NULL END,
      media_approved_at=CASE WHEN $4 THEN now() ELSE NULL END,
      approved_by=CASE WHEN $3 AND $4 THEN $5 ELSE NULL END,
      approval_fingerprint=CASE WHEN $3 AND $4 THEN $6 ELSE NULL END
    WHERE id=$1 AND workspace_id=$2 RETURNING *
  `,[variantId,workspaceId,input.copy_approved,input.media_approved,userId,fingerprint]);
  await audit(workspaceId,userId,variant.provider,"content_approval",
    input.copy_approved && input.media_approved ? "success" : "blocked",
    { content_variant_id:variantId },db);
  return result.rows[0];
};

export const createPublishJob = async (
  workspaceId: string,
  userId: string,
  input: Input,
  db: Db = pool
) => {
  const connectionId = uuid(input.connection_id, "connection_id");
  const variantId = uuid(input.content_variant_id, "content_variant_id");
  const result = await db.query(`
    INSERT INTO growth_os.social_publish_jobs(
      workspace_id,connection_id,content_variant_id,status
    )
    SELECT $1,c.id,v.id,'draft'
    FROM growth_os.social_connections c
    JOIN growth_os.social_content_variants v
      ON v.id=$3 AND v.workspace_id=$1 AND v.provider=c.provider
    WHERE c.id=$2 AND c.workspace_id=$1
    RETURNING *
  `, [workspaceId,connectionId,variantId]);
  if (!result.rows[0]) throw socialError("Connection and content variant must belong to this workspace", "social_workspace_mismatch", 404);
  await audit(workspaceId,userId,null,"publish_job_created","success",{ publish_job_id: result.rows[0].id },db);
  return result.rows[0];
};

export const schedulePublishJob = async (
  workspaceId: string,
  userId: string,
  jobIdValue: string,
  input: Input,
  db: Db = pool
) => {
  const jobId = uuid(jobIdValue, "job_id");
  const scheduledFor = safeText(input.scheduled_for, "scheduled_for", 100);
  if (Number.isNaN(Date.parse(scheduledFor))) throw socialError("scheduled_for must be an ISO timestamp");
  const result = await db.query(`
    SELECT j.*,c.status AS connection_status,c.last_successful_check_at,
      c.discovered_capabilities,v.copy_approved_at,v.media_approved_at,
      v.destination_reference,v.approval_fingerprint AS variant_fingerprint,
      v.copy,v.media_references
    FROM growth_os.social_publish_jobs j
    JOIN growth_os.social_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
    JOIN growth_os.social_content_variants v ON v.id=j.content_variant_id AND v.workspace_id=j.workspace_id
    WHERE j.id=$1 AND j.workspace_id=$2
  `, [jobId,workspaceId]);
  const job = result.rows[0];
  if (!job) throw socialError("Publish job not found", "social_publish_job_not_found", 404);
  const currentContent = { copy: job.copy, media: job.media_references, destination: job.destination_reference };
  const currentFingerprint = fingerprintSocialContent(currentContent);
  const readiness = validatePublishReadiness({
    copyApproved: Boolean(job.copy_approved_at) && !approvalMustReset(job.variant_fingerprint,currentContent),
    mediaApproved: Boolean(job.media_approved_at) && !approvalMustReset(job.variant_fingerprint,currentContent),
    destinationValid: Boolean(job.destination_reference),
    connected: job.connection_status === "connected",
    healthy: Boolean(job.last_successful_check_at),
    requiredCapabilities: [],
    availableCapabilities: job.discovered_capabilities ?? []
  });
  if (!readiness.ready) {
    await audit(workspaceId,userId,null,"publish_schedule","blocked",{ missing: readiness.missing,publish_job_id:jobId },db);
    throw socialError(`Publishing is blocked: ${readiness.missing.join(", ")}`, "social_publish_not_ready", 409);
  }
  const updated = await db.query(`
    UPDATE growth_os.social_publish_jobs SET
      status='scheduled',scheduled_for=$3,approved_at=now(),approved_by=$4,
      approval_fingerprint=$5
    WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','approved','retry')
    RETURNING *
  `, [jobId,workspaceId,new Date(scheduledFor).toISOString(),userId,currentFingerprint]);
  if (!updated.rows[0]) throw socialError("Publish job cannot be scheduled from its current state", "social_schedule_state_invalid", 409);
  await audit(workspaceId,userId,null,"publish_schedule","success",{ publish_job_id:jobId },db);
  return updated.rows[0];
};
