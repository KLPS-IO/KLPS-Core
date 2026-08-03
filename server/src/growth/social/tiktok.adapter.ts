import {
  OAuthTokenResult,
  ProviderEnvironment,
  SocialProviderDefinition
} from "./social.types";

const TIKTOK_USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const TIKTOK_USER_INFO_FIELDS = ["open_id","display_name"] as const;

type TikTokTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  open_id?: unknown;
  scope?: unknown;
  error?: unknown;
  log_id?: unknown;
};

type TikTokUserInfoResponse = {
  data?: { user?: { open_id?: unknown; display_name?: unknown } };
  error?: { code?: unknown; log_id?: unknown };
};

const SAFE_OAUTH_CATEGORIES = new Set([
  "access_denied","invalid_client","invalid_grant","invalid_request","invalid_scope",
  "unauthorized_client","unsupported_grant_type","unsupported_response_type",
  "server_error","temporarily_unavailable"
]);

const safeString = (value: unknown, maxLength = 128) =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value : undefined;

const tiktokError = (
  message: string,
  code: string,
  providerCategory?: unknown,
  providerLogId?: unknown
) => Object.assign(new Error(message),{
  code,statusCode:502,
  providerErrorCategory:typeof providerCategory === "string" && SAFE_OAUTH_CATEGORIES.has(providerCategory)
    ? providerCategory : undefined,
  providerLogId:safeString(providerLogId)
});

const readJson = async <T>(response: Response): Promise<T | undefined> => {
  try {
    const value=await response.json();
    return value && typeof value === "object" ? value as T : undefined;
  } catch {
    return undefined;
  }
};

const grantedIdentityScopes = (value: unknown, allowed: string[]) => {
  if (typeof value !== "string") return [];
  const granted=new Set(value.split(",").map(scope => scope.trim()).filter(Boolean));
  return allowed.filter(scope => granted.has(scope));
};

export const exchangeTikTokAuthorizationCode = async (
  definition: SocialProviderDefinition,
  environment: ProviderEnvironment,
  input: { code: string; redirectUri: string }
): Promise<OAuthTokenResult> => {
  if (!definition.tokenUrl || !environment.clientId || !environment.clientSecret) {
    throw tiktokError("TikTok OAuth is not configured","tiktok_oauth_not_configured");
  }

  let tokenResponse:Response;
  try {
    tokenResponse=await fetch(definition.tokenUrl,{
      method:"POST",
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/x-www-form-urlencoded"
      },
      body:new URLSearchParams({
        client_key:environment.clientId,
        client_secret:environment.clientSecret,
        code:input.code,
        grant_type:"authorization_code",
        redirect_uri:input.redirectUri
      }),
      signal:AbortSignal.timeout(15_000)
    });
  } catch {
    throw tiktokError("TikTok token exchange failed","tiktok_token_exchange_failed");
  }

  const token=await readJson<TikTokTokenResponse>(tokenResponse);
  if (
    !tokenResponse.ok || !token ||
    typeof token.access_token !== "string" || !token.access_token ||
    typeof token.open_id !== "string" || !token.open_id
  ) throw tiktokError(
    "TikTok token exchange failed","tiktok_token_exchange_failed",
    token?.error,token?.log_id
  );

  const fields=TIKTOK_USER_INFO_FIELDS.join(",");
  let identityResponse:Response;
  try {
    identityResponse=await fetch(`${TIKTOK_USER_INFO_URL}?fields=${fields}`,{
      headers:{
        "Accept":"application/json",
        "Authorization":`Bearer ${token.access_token}`
      },
      signal:AbortSignal.timeout(15_000)
    });
  } catch {
    throw tiktokError("TikTok identity lookup failed","tiktok_identity_lookup_failed");
  }

  const identity=await readJson<TikTokUserInfoResponse>(identityResponse);
  const user=identity?.data?.user;
  if (
    !identityResponse.ok || identity?.error?.code !== "ok" ||
    typeof user?.open_id !== "string" || !user.open_id.trim() ||
    user.open_id !== token.open_id ||
    typeof user.display_name !== "string" || !user.display_name.trim()
  ) throw tiktokError(
    "TikTok identity lookup failed","tiktok_identity_lookup_failed",
    identity?.error?.code,identity?.error?.log_id
  );

  const expiresIn=typeof token.expires_in === "number" && token.expires_in > 0
    ? token.expires_in : undefined;
  return {
    accessToken:token.access_token,
    refreshToken:typeof token.refresh_token === "string" && token.refresh_token
      ? token.refresh_token : undefined,
    expiresAt:expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined,
    scopes:grantedIdentityScopes(token.scope,definition.scopes),
    providerAccountId:user.open_id.trim(),
    providerAccountName:user.display_name.trim(),
    providerAccountType:"member",
    discoveredCapabilities:[],
    discoveredAssets:[]
  };
};
