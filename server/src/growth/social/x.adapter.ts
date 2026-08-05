import {
  OAuthTokenResult,
  ProviderEnvironment,
  SocialProviderDefinition
} from "./social.types";
import { safeXOAuthCategory } from "./x.diagnostics";

const X_AUTHENTICATED_USER_URL="https://api.x.com/2/users/me";

type XTokenResponse = {
  access_token?:unknown;
  refresh_token?:unknown;
  expires_in?:unknown;
  scope?:unknown;
};

type XUserResponse = {
  data?:{ id?:unknown; name?:unknown; username?:unknown };
};

const xError=(message:string,code:string,statusCode=502) =>
  Object.assign(new Error(message),{code,statusCode});

const readJson=async <T>(response:Response):Promise<T | undefined> => {
  try {
    const value=await response.json();
    return value && typeof value === "object" ? value as T : undefined;
  } catch { return undefined; }
};

const parseGrantedScopes=(value:unknown,allowed:string[]) => {
  if (typeof value !== "string") return [];
  const granted=new Set(value.split(/[\s,]+/).map(scope => scope.trim()).filter(Boolean));
  return allowed.filter(scope => granted.has(scope));
};

export const exchangeXAuthorizationCode=async (
  definition:SocialProviderDefinition,
  environment:ProviderEnvironment,
  input:{code:string;codeVerifier?:string;redirectUri:string;diagnostics?:import("./social.types").MetaOAuthDiagnostics}
):Promise<OAuthTokenResult> => {
  if (
    !definition.tokenUrl || !environment.clientId || !environment.clientSecret ||
    !input.codeVerifier
  ) throw xError("X OAuth is not configured","x_oauth_not_configured",503);

  let tokenResponse:Response;
  input.diagnostics?.emit("x_oauth_token_exchange_started",{stage:"token_exchange"});
  try {
    tokenResponse=await fetch(definition.tokenUrl,{
      method:"POST",
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/x-www-form-urlencoded",
        "Authorization":`Basic ${Buffer.from(`${environment.clientId}:${environment.clientSecret}`).toString("base64")}`
      },
      body:new URLSearchParams({
        code:input.code,
        grant_type:"authorization_code",
        redirect_uri:input.redirectUri,
        code_verifier:input.codeVerifier
      }),
      signal:AbortSignal.timeout(15_000)
    });
  } catch {
    input.diagnostics?.emit("x_oauth_token_exchange_failed",{
      stage:"token_exchange",x_error_category:"network_failure"
    });
    throw xError("X token exchange failed","x_token_exchange_failed");
  }
  const token=await readJson<XTokenResponse>(tokenResponse);
  if (!tokenResponse.ok || typeof token?.access_token !== "string" || !token.access_token) {
    input.diagnostics?.emit("x_oauth_token_exchange_failed",{
      stage:"token_exchange",x_http_status:tokenResponse.status,
      x_error_category:safeXOAuthCategory(token,tokenResponse.status)
    });
    throw xError("X token exchange failed","x_token_exchange_failed");
  }
  input.diagnostics?.emit("x_oauth_token_exchange_completed",{
    stage:"token_exchange",x_http_status:tokenResponse.status,
    x_refresh_token_returned:typeof token.refresh_token === "string" && Boolean(token.refresh_token)
  });

  let identityResponse:Response;
  input.diagnostics?.emit("x_oauth_identity_lookup_started",{stage:"identity_lookup"});
  try {
    identityResponse=await fetch(X_AUTHENTICATED_USER_URL,{
      headers:{"Accept":"application/json","Authorization":`Bearer ${token.access_token}`},
      signal:AbortSignal.timeout(15_000)
    });
  } catch {
    input.diagnostics?.emit("x_oauth_identity_lookup_failed",{
      stage:"identity_lookup",x_error_category:"network_failure"
    });
    throw xError("X identity lookup failed","x_identity_lookup_failed");
  }
  const identity=await readJson<XUserResponse>(identityResponse);
  const user=identity?.data;
  if (
    !identityResponse.ok || typeof user?.id !== "string" || !user.id.trim() ||
    typeof user.name !== "string" || !user.name.trim() ||
    typeof user.username !== "string" || !user.username.trim()
  ) {
    input.diagnostics?.emit("x_oauth_identity_lookup_failed",{
      stage:"identity_lookup",x_http_status:identityResponse.status,
      x_error_category:safeXOAuthCategory(identity,identityResponse.status)
    });
    throw xError("X identity lookup failed","x_identity_lookup_failed");
  }
  input.diagnostics?.emit("x_oauth_identity_lookup_completed",{
    stage:"identity_lookup",x_http_status:identityResponse.status
  });

  const expiresIn=typeof token.expires_in === "number" && token.expires_in > 0
    ? token.expires_in : undefined;
  return {
    accessToken:token.access_token,
    refreshToken:typeof token.refresh_token === "string" && token.refresh_token
      ? token.refresh_token : undefined,
    expiresAt:expiresIn ? new Date(Date.now()+expiresIn*1000) : undefined,
    scopes:parseGrantedScopes(token.scope,definition.scopes),
    providerAccountId:user.id.trim(),
    // The provider-neutral display field holds the public display name.
    providerAccountName:user.name.trim(),
    providerAccountType:"member",
    discoveredCapabilities:[],
    // Store only the authenticated account identity. No post or engagement
    // endpoint is called, despite X requiring tweet.read for this lookup.
    discoveredAssets:[{
      provider:"x",providerAssetType:"account",providerAssetId:user.id.trim(),
      providerAssetName:user.name.trim(),providerAssetUsername:user.username.trim().replace(/^@/,"")
    }]
  };
};
