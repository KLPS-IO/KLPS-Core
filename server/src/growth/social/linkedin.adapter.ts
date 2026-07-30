import {
  OAuthTokenResult,
  ProviderEnvironment,
  SocialProviderDefinition
} from "./social.types";

const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

type LinkedInTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

type LinkedInUserInfo = {
  sub?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
};

const linkedinError = (message: string, code: string, statusCode = 502) =>
  Object.assign(new Error(message), { code, statusCode });

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const parseGrantedScopes = (value: unknown) => {
  if (typeof value !== "string") return [];
  return [...new Set(
    value.split(/[\s,]+/).map(scope => scope.trim()).filter(Boolean)
  )];
};

const identityName = (identity: LinkedInUserInfo) => {
  if (typeof identity.name === "string" && identity.name.trim()) return identity.name.trim();
  const parts = [identity.given_name, identity.family_name]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .map(part => part.trim());
  return parts.join(" ");
};

export const exchangeLinkedInAuthorizationCode = async (
  definition: SocialProviderDefinition,
  environment: ProviderEnvironment,
  input: { code: string; codeVerifier?: string; redirectUri: string }
): Promise<OAuthTokenResult> => {
  if (!definition.tokenUrl || !environment.clientId || !environment.clientSecret) {
    throw linkedinError("LinkedIn OAuth is not configured", "linkedin_oauth_not_configured", 503);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: environment.clientId,
    client_secret: environment.clientSecret,
    redirect_uri: input.redirectUri
  });
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(definition.tokenUrl, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw linkedinError("LinkedIn token exchange failed", "linkedin_token_exchange_failed");
  }

  const tokenPayload = await readJson(tokenResponse) as LinkedInTokenResponse;
  if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
    throw linkedinError("LinkedIn token exchange failed", "linkedin_token_exchange_failed");
  }

  let identityResponse: Response;
  try {
    identityResponse = await fetch(LINKEDIN_USERINFO_URL, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${tokenPayload.access_token}`
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw linkedinError("LinkedIn identity verification failed", "linkedin_identity_lookup_failed");
  }

  const identity = await readJson(identityResponse) as LinkedInUserInfo;
  const accountName = identityName(identity);
  if (
    !identityResponse.ok ||
    typeof identity.sub !== "string" ||
    !identity.sub.trim() ||
    !accountName
  ) {
    throw linkedinError("LinkedIn identity verification failed", "linkedin_identity_lookup_failed");
  }

  const expiresIn = typeof tokenPayload.expires_in === "number" && tokenPayload.expires_in > 0
    ? tokenPayload.expires_in
    : undefined;

  return {
    accessToken: tokenPayload.access_token,
    refreshToken: typeof tokenPayload.refresh_token === "string" && tokenPayload.refresh_token
      ? tokenPayload.refresh_token
      : undefined,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined,
    scopes: parseGrantedScopes(tokenPayload.scope),
    providerAccountId: identity.sub.trim(),
    providerAccountName: accountName,
    providerAccountType: "member",
    // Identity activation does not imply member or organisation publishing rights.
    discoveredCapabilities: []
  };
};
