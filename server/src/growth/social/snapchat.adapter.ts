import {
  OAuthTokenResult,
  ProviderEnvironment,
  SocialProviderDefinition
} from "./social.types";

const SNAPCHAT_USERINFO_URL =
  "https://kit.snapchat.com/v1/me";

type SnapchatTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

type SnapchatIdentityResponse = {
  data?: {
    me?: {
      externalId?: unknown;
      displayName?: unknown;
    };
  };
};

const snapchatError = (
  message: string,
  code: string,
  statusCode = 502
) => Object.assign(new Error(message), { code, statusCode });

const readJson = async <T>(
  response: Response
): Promise<T | undefined> => {
  try {
    const value = await response.json();
    return value && typeof value === "object"
      ? value as T
      : undefined;
  } catch {
    return undefined;
  }
};

const parseGrantedScopes = (
  value: unknown,
  allowed: string[]
) => {
  if (typeof value !== "string") return [];

  const granted = new Set(
    value
      .split(/[\s,]+/)
      .map(scope => scope.trim())
      .filter(Boolean)
  );

  return allowed.filter(scope => granted.has(scope));
};

export const exchangeSnapchatAuthorizationCode = async (
  definition: SocialProviderDefinition,
  environment: ProviderEnvironment,
  input: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
  }
): Promise<OAuthTokenResult> => {
  if (
    !definition.tokenUrl ||
    !environment.clientId ||
    !environment.clientSecret ||
    !input.codeVerifier
  ) {
    throw snapchatError(
      "Snapchat OAuth is not configured",
      "snapchat_oauth_not_configured",
      503
    );
  }

  let tokenResponse: Response;

  try {
    tokenResponse = await fetch(definition.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: environment.clientId,
        client_secret: environment.clientSecret,
        code_verifier: input.codeVerifier
      }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw snapchatError(
      "Snapchat token exchange failed",
      "snapchat_token_exchange_failed"
    );
  }

  const token =
    await readJson<SnapchatTokenResponse>(tokenResponse);

  if (
    !tokenResponse.ok ||
    typeof token?.access_token !== "string" ||
    !token.access_token
  ) {
    throw snapchatError(
      "Snapchat token exchange failed",
      "snapchat_token_exchange_failed"
    );
  }

  let identityResponse: Response;

  try {
    identityResponse = await fetch(
      SNAPCHAT_USERINFO_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.access_token}`
        },
        body: JSON.stringify({
          query: `{
            me {
              externalId
              displayName
            }
          }`
        }),
        signal: AbortSignal.timeout(15_000)
      }
    );
  } catch {
    throw snapchatError(
      "Snapchat identity lookup failed",
      "snapchat_identity_lookup_failed"
    );
  }

  const identity =
    await readJson<SnapchatIdentityResponse>(
      identityResponse
    );

  const user = identity?.data?.me;

  if (
    !identityResponse.ok ||
    typeof user?.externalId !== "string" ||
    !user.externalId.trim() ||
    typeof user.displayName !== "string" ||
    !user.displayName.trim()
  ) {
    throw snapchatError(
      "Snapchat identity lookup failed",
      "snapchat_identity_lookup_failed"
    );
  }

  const expiresIn =
    typeof token.expires_in === "number" &&
    token.expires_in > 0
      ? token.expires_in
      : undefined;

  return {
    accessToken: token.access_token,
    refreshToken:
      typeof token.refresh_token === "string" &&
      token.refresh_token
        ? token.refresh_token
        : undefined,
    expiresAt: expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : undefined,
    scopes: parseGrantedScopes(
      token.scope,
      definition.scopes
    ),
    providerAccountId: user.externalId.trim(),
    providerAccountName: user.displayName.trim(),
    providerAccountType: "member",
    discoveredCapabilities: [],
    discoveredAssets: []
  };
};