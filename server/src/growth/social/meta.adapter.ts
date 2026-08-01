import {
  OAuthTokenResult,
  MetaOAuthDiagnostics,
  ProviderEnvironment,
  SocialCapability,
  SocialDiscoveredAsset,
  SocialProviderDefinition
} from "./social.types";

const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const META_GRAPH_VERSION = "v23.0";

type MetaTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type MetaIdentity = {
  id?: unknown;
  name?: unknown;
};

type MetaPermission = {
  permission?: unknown;
  status?: unknown;
};

type MetaPage = {
  id?: unknown;
  name?: unknown;
  instagram_business_account?: {
    id?: unknown;
    name?: unknown;
    username?: unknown;
  };
};

export type MetaDiscoveredIdentity = SocialDiscoveredAsset;

const metaError = (message: string, code: string, statusCode = 502) =>
  Object.assign(new Error(message), { code, statusCode });

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const graphGet = async (path: string, accessToken: string) => {
  try {
    return await fetch(`${META_GRAPH_ORIGIN}/${META_GRAPH_VERSION}${path}`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw metaError("Meta identity verification failed", "meta_identity_lookup_failed");
  }
};

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const discoverMetaBusinessIdentities = async (
  accessToken: string,
  diagnostics?: MetaOAuthDiagnostics
): Promise<MetaDiscoveredIdentity[]> => {
  let response:Response;
  try {
    response = await graphGet(
      "/me/accounts?fields=id,name,instagram_business_account{id,name,username}",
      accessToken
    );
  } catch {
    diagnostics?.emit("meta_oauth_page_discovery_failed",{
      internal_error_code:"meta_page_discovery_failed",stage:"page_discovery"
    });
    throw metaError("Meta Page discovery failed", "meta_page_discovery_failed");
  }
  const payload = await readJson(response);
  if (!response.ok || !Array.isArray(payload.data)) {
    diagnostics?.emit("meta_oauth_page_discovery_failed",{
      internal_error_code:"meta_page_discovery_failed",stage:"page_discovery",
      meta_http_status:response.status
    });
    throw metaError("Meta Page discovery failed", "meta_page_discovery_failed");
  }
  const identities: MetaDiscoveredIdentity[] = [];
  for (const value of payload.data) {
    if (!value || typeof value !== "object") continue;
    const page = value as MetaPage;
    const pageId = nonEmpty(page.id);
    const pageName = nonEmpty(page.name);
    if (!pageId || !pageName) continue;
    identities.push({
      provider: "facebook",
      providerAssetType: "page",
      providerAssetId: pageId,
      providerAssetName: pageName,
      providerAssetUsername: null
    });
    const instagramId = nonEmpty(page.instagram_business_account?.id);
    const instagramUsername = nonEmpty(page.instagram_business_account?.username);
    const instagramName = nonEmpty(page.instagram_business_account?.name) ?? instagramUsername;
    if (instagramId && instagramName) identities.push({
      provider: "instagram",
      providerAssetType: "instagram_professional",
      providerAssetId: instagramId,
      providerAssetName: instagramName,
      providerAssetUsername: instagramUsername
    });
  }
  const pageFound = identities.some(identity => identity.provider === "facebook");
  const instagramFound = identities.some(identity => identity.provider === "instagram");
  diagnostics?.emit("meta_oauth_page_discovery_completed",{
    stage:"page_discovery",page_found:pageFound,instagram_found:instagramFound
  });
  diagnostics?.emit("meta_oauth_instagram_discovery_completed",{
    stage:"instagram_discovery",page_found:pageFound,instagram_found:instagramFound
  });
  return identities;
};

const grantedMetaScopes = async (accessToken: string, diagnostics?: MetaOAuthDiagnostics) => {
  let response:Response;
  try {
    response = await graphGet("/me/permissions", accessToken);
  } catch {
    diagnostics?.emit("meta_oauth_permissions_missing",{
      internal_error_code:"meta_permissions_missing",stage:"permissions"
    });
    throw metaError("Meta permission verification failed", "meta_permission_lookup_failed");
  }
  const payload = await readJson(response);
  if (!response.ok || !Array.isArray(payload.data)) {
    diagnostics?.emit("meta_oauth_permissions_missing",{
      internal_error_code:"meta_permissions_missing",stage:"permissions",
      meta_http_status:response.status
    });
    throw metaError("Meta permission verification failed", "meta_permission_lookup_failed");
  }
  return payload.data
    .filter((value): value is MetaPermission => Boolean(value && typeof value === "object"))
    .filter(value => value.status === "granted")
    .map(value => nonEmpty(value.permission))
    .filter((value): value is string => Boolean(value));
};

export const exchangeMetaAuthorizationCode = async (
  definition: SocialProviderDefinition,
  environment: ProviderEnvironment,
  input: { code: string; redirectUri: string; diagnostics?: MetaOAuthDiagnostics }
): Promise<OAuthTokenResult> => {
  if (!definition.tokenUrl || !environment.clientId || !environment.clientSecret) {
    input.diagnostics?.emit("meta_oauth_code_exchange_failed",{
      internal_error_code:"meta_token_exchange_failed",stage:"code_exchange"
    });
    throw metaError("Meta OAuth is not configured", "meta_oauth_not_configured", 503);
  }

  const tokenUrl = new URL(definition.tokenUrl);
  tokenUrl.searchParams.set("client_id", environment.clientId);
  tokenUrl.searchParams.set("client_secret", environment.clientSecret);
  tokenUrl.searchParams.set("redirect_uri", input.redirectUri);
  tokenUrl.searchParams.set("code", input.code);

  let tokenResponse: Response;
  input.diagnostics?.emit("meta_oauth_code_exchange_started",{ stage:"code_exchange" });
  try {
    tokenResponse = await fetch(tokenUrl, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    input.diagnostics?.emit("meta_oauth_code_exchange_failed",{
      internal_error_code:"meta_token_exchange_failed",stage:"code_exchange"
    });
    throw metaError("Meta token exchange failed", "meta_token_exchange_failed");
  }
  const tokenPayload = await readJson(tokenResponse) as MetaTokenResponse;
  if (
    !tokenResponse.ok ||
    typeof tokenPayload.access_token !== "string" ||
    !tokenPayload.access_token
  ) {
    input.diagnostics?.emit("meta_oauth_code_exchange_failed",{
      internal_error_code:"meta_token_exchange_failed",stage:"code_exchange",
      meta_http_status:tokenResponse.status
    });
    throw metaError("Meta token exchange failed", "meta_token_exchange_failed");
  }

  let identityResponse:Response;
  try {
    identityResponse = await graphGet("/me?fields=id,name", tokenPayload.access_token);
  } catch {
    input.diagnostics?.emit("meta_oauth_identity_lookup_failed",{
      internal_error_code:"meta_identity_lookup_failed",stage:"identity_lookup"
    });
    throw metaError("Meta identity verification failed", "meta_identity_lookup_failed");
  }
  const identity = await readJson(identityResponse) as MetaIdentity;
  const identityId = nonEmpty(identity.id);
  const identityName = nonEmpty(identity.name);
  if (!identityResponse.ok || !identityId || !identityName) {
    input.diagnostics?.emit("meta_oauth_identity_lookup_failed",{
      internal_error_code:"meta_identity_lookup_failed",stage:"identity_lookup",
      meta_http_status:identityResponse.status
    });
    throw metaError("Meta identity verification failed", "meta_identity_lookup_failed");
  }
  input.diagnostics?.emit("meta_oauth_identity_lookup_succeeded",{ stage:"identity_lookup" });

  const scopes = await grantedMetaScopes(tokenPayload.access_token,input.diagnostics);
  const missingPermissions = definition.scopes.filter(scope => !scopes.includes(scope));
  if (missingPermissions.length) {
    input.diagnostics?.emit("meta_oauth_permissions_missing",{
      internal_error_code:"meta_permissions_missing",stage:"permissions",
      missing_permissions:missingPermissions
    });
    throw metaError("Required Meta permissions were not granted", "meta_permissions_missing", 403);
  }
  input.diagnostics?.emit("meta_oauth_permissions_checked",{
    stage:"permissions",missing_permissions:[]
  });
  const discoveredAssets = await discoverMetaBusinessIdentities(tokenPayload.access_token,input.diagnostics);
  const expiresIn = typeof tokenPayload.expires_in === "number" && tokenPayload.expires_in > 0
    ? tokenPayload.expires_in
    : undefined;

  return {
    accessToken: tokenPayload.access_token,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined,
    scopes,
    providerAccountId: identityId,
    providerAccountName: identityName,
    providerAccountType: "member",
    // Identity and account discovery do not imply publishing or management rights.
    discoveredCapabilities: [],
    discoveredAssets
  };
};

export const checkMetaIdentityHealth = async (accessToken: string) => {
  const response = await graphGet("/me?fields=id", accessToken);
  const identity = await readJson(response);
  return {
    healthy: response.ok && Boolean(nonEmpty(identity.id)),
    capabilities: [] as SocialCapability[]
  };
};
