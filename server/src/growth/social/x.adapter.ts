import {
  OAuthTokenResult,
  OAuthRefreshResult,
  SocialCapability,
  SocialPublishInput,
  SocialPublishResult,
  ProviderEnvironment,
  SocialProviderDefinition
} from "./social.types";
import { safeXOAuthCategory } from "./x.diagnostics";

import { parseTweet } from "twitter-text";
import { SocialPublishError } from "./social.publish-error";

export const X_WRITE_SCOPES = ["tweet.read", "users.read", "tweet.write"];
export const xPublishingCapabilities = (scopes: string[]): SocialCapability[] =>
  X_WRITE_SCOPES.every(scope => scopes.includes(scope)) ? ["text", "direct_publishing"] : [];

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
    discoveredCapabilities:xPublishingCapabilities(parseGrantedScopes(token.scope,definition.scopes)),
    // Store only the authenticated account identity. No post or engagement
    // endpoint is called, despite X requiring tweet.read for this lookup.
    discoveredAssets:[]
  };
};

export function validateXTextPost(input: SocialPublishInput) {
  if (!Array.isArray(input.media) || input.media.length) throw new SocialPublishError(
    'social_media_not_supported', 'X publishing currently supports text only.', 'rejected');
  if (typeof input.text !== 'string' || !input.text.trim() || !parseTweet(input.text).valid)
    throw new SocialPublishError('social_text_invalid', 'Enter a valid X post of at most 280 weighted characters.', 'rejected');
}

export async function publishXText(accessToken: string, input: SocialPublishInput): Promise<SocialPublishResult> {
  validateXTextPost(input);
  let response: Response;
  try {
    response = await fetch('https://api.x.com/2/tweets', {
      method: 'POST', redirect: 'error',
      headers: {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({text: input.text}), signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new SocialPublishError('social_publish_outcome_unknown', 'X did not confirm the outcome. Check X before taking further action; this request will not be resent.', 'unknown');
  }
  const payload = await readJson<{data?: {id?: unknown}}>(response);
  if (response.ok && typeof payload?.data?.id === 'string' && /^\d+$/.test(payload.data.id))
    return {postId: payload.data.id, postUrl: `https://x.com/i/web/status/${payload.data.id}`};
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
    const after = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.now() + 15 * 60_000;
    throw new SocialPublishError('social_rate_limited', 'X rate limit reached. A founder can retry this job after the cooldown.', 'rejected', new Date(Math.min(Date.now()+86400_000,Math.max(after,Number.isFinite(reset)?reset:0))), false, 429);
  }
  if (response.status === 401) throw new SocialPublishError('social_reauthorization_required', 'Reconnect X before explicitly retrying this job.', 'rejected', new Date(), true, 401);
  if (response.status >= 400 && response.status < 500) throw new SocialPublishError(
    'social_provider_rejected', 'X rejected this post. Check account permissions, API access and content before preparing another approval.', 'rejected', null, false, response.status);
  throw new SocialPublishError('social_publish_outcome_unknown', 'X did not confirm the outcome. Check X; this request will not be resent.', 'unknown', null, false, response.status);
}

export async function refreshXAccessToken(definition: SocialProviderDefinition, environment: ProviderEnvironment, refreshToken: string): Promise<OAuthRefreshResult> {
  if (!environment.clientId || !environment.clientSecret || !definition.tokenUrl)
    throw new SocialPublishError('social_reauthorization_required', 'X authentication is not configured.', 'rejected', null, true);
  let response: Response;
  try {
    response = await fetch(definition.tokenUrl, {
      method: 'POST', redirect: 'error',
      headers: {Accept:'application/json', 'Content-Type':'application/x-www-form-urlencoded', Authorization:`Basic ${Buffer.from(`${environment.clientId}:${environment.clientSecret}`).toString('base64')}`},
      body: new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}), signal:AbortSignal.timeout(15_000)
    });
  } catch { throw new SocialPublishError('social_reauthorization_required', 'X token refresh was not confirmed. Reconnect X.', 'rejected', null, true); }
  const token = await readJson<XTokenResponse>(response);
  if (!response.ok || typeof token?.access_token !== 'string' || !token.access_token || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0)
    throw new SocialPublishError('social_reauthorization_required', 'X token refresh failed. Reconnect X.', 'rejected', null, true);
  return {accessToken:token.access_token, refreshToken:typeof token.refresh_token==='string' && token.refresh_token ? token.refresh_token : undefined,
    expiresAt:new Date(Date.now()+token.expires_in*1000),
    // RFC 6749: omitted refresh scopes retain the original grant, never the requested scopes.
    scopes:token.scope===undefined ? undefined : parseGrantedScopes(token.scope,definition.scopes)};
}
