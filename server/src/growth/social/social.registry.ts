import {
  SOCIAL_PROVIDERS,
  SocialProvider,
  SocialProviderAdapter,
  SocialProviderDefinition
} from "./social.types";

const definitions: Record<SocialProvider, SocialProviderDefinition> = {
  linkedin: {
    id: "linkedin", name: "LinkedIn",
    developerAccount: "LinkedIn Developer account",
    applicationName: "LinkedIn application with Community Management access",
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid","profile","w_member_social"],
    capabilities: ["text","images","video","clickable_links","metrics","direct_publishing"],
    requiredEnvironment: ["LINKEDIN_CLIENT_ID","LINKEDIN_CLIENT_SECRET","LINKEDIN_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: ["Request and receive access to the required LinkedIn products and publishing permissions."]
  },
  facebook: {
    id: "facebook", name: "Facebook Pages",
    developerAccount: "Meta for Developers account",
    applicationName: "Meta application connected to the KLPS Facebook Page",
    authorizationUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    scopes: ["pages_show_list","pages_read_engagement","pages_manage_posts","read_insights"],
    capabilities: ["text","images","video","clickable_links","scheduling","metrics","comment_retrieval","direct_publishing"],
    requiredEnvironment: ["META_CLIENT_ID","META_CLIENT_SECRET","META_FACEBOOK_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: ["Complete Meta Business verification where required.", "Submit advanced permissions for App Review."]
  },
  instagram: {
    id: "instagram", name: "Instagram Professional",
    developerAccount: "Meta for Developers account",
    applicationName: "Meta application connected to an Instagram Professional account",
    authorizationUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    scopes: ["instagram_basic","instagram_content_publish","instagram_manage_insights","pages_show_list"],
    capabilities: ["images","video","carousel","reels","metrics","comment_retrieval","direct_publishing"],
    requiredEnvironment: ["META_CLIENT_ID","META_CLIENT_SECRET","META_INSTAGRAM_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: ["Connect Instagram Professional to a Facebook Page.", "Submit Instagram permissions for Meta App Review."]
  },
  x: {
    id: "x", name: "X",
    developerAccount: "X Developer account with an approved project",
    applicationName: "X OAuth 2.0 application",
    authorizationUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read","tweet.write","users.read","offline.access"],
    capabilities: ["text","images","video","threads","clickable_links","metrics","direct_publishing"],
    requiredEnvironment: ["X_CLIENT_ID","X_REDIRECT_URI"],
    supportsPkce: true,
    externalReview: ["Select an X API access tier that permits the intended publishing and metrics volume."]
  },
  tiktok: {
    id: "tiktok", name: "TikTok",
    developerAccount: "TikTok for Developers account",
    applicationName: "TikTok Login Kit and Content Posting application",
    authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic","video.publish","video.upload"],
    capabilities: ["video","metrics","draft_upload","direct_publishing"],
    requiredEnvironment: ["TIKTOK_CLIENT_KEY","TIKTOK_CLIENT_SECRET","TIKTOK_REDIRECT_URI"],
    supportsPkce: true,
    externalReview: ["Submit Login Kit and Content Posting API scopes for TikTok review.", "Complete TikTok audit requirements before public direct posting."]
  },
  snapchat: {
    id: "snapchat", name: "Snapchat",
    developerAccount: "Snap Developer account",
    applicationName: "Snap Kit application",
    authorizationUrl: null, tokenUrl: null, scopes: [],
    capabilities: ["images","video","stories","metrics"],
    requiredEnvironment: [],
    supportsPkce: true,
    externalReview: ["Provider adapter is reserved for a future approved Snap integration."],
    futureReady: true
  }
};

const providerEnv = (provider: SocialProvider) => {
  if (provider === "facebook" || provider === "instagram") return {
    clientId: process.env.META_CLIENT_ID,
    clientSecret: process.env.META_CLIENT_SECRET,
    redirectUri: provider === "facebook"
      ? process.env.META_FACEBOOK_REDIRECT_URI
      : process.env.META_INSTAGRAM_REDIRECT_URI
  };
  if (provider === "linkedin") return {
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI
  };
  if (provider === "x") return {
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
    redirectUri: process.env.X_REDIRECT_URI
  };
  if (provider === "tiktok") return {
    clientId: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    redirectUri: process.env.TIKTOK_REDIRECT_URI
  };
  return {};
};

const unavailable = (message: string) =>
  Object.assign(new Error(message), { code: "social_provider_not_activated", statusCode: 409 });

const adapterFor = (definition: SocialProviderDefinition): SocialProviderAdapter => ({
  definition,
  getEnvironment: () => providerEnv(definition.id),
  buildAuthorizationUrl: ({ state, codeChallenge, redirectUri }) => {
    if (!definition.authorizationUrl) throw unavailable(`${definition.name} is future-ready but not enabled`);
    const environment = providerEnv(definition.id);
    if (!environment.clientId) throw unavailable(`${definition.name} client credentials are not configured`);
    const url = new URL(definition.authorizationUrl);
    url.searchParams.set(definition.id === "tiktok" ? "client_key" : "client_id", environment.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", definition.scopes.join(definition.id === "tiktok" ? "," : " "));
    url.searchParams.set("state", state);
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  },
  exchangeAuthorizationCode: async () => {
    throw unavailable(`${definition.name} token exchange awaits developer credentials and provider approval`);
  },
  refreshToken: async () => {
    throw unavailable(`${definition.name} token refresh awaits provider activation`);
  },
  revokeToken: async () => {
    throw unavailable(`${definition.name} token revocation awaits provider activation`);
  },
  publish: async () => {
    throw unavailable(`${definition.name} publishing is intentionally disabled in Phase 4A`);
  },
  checkHealth: async () => ({ healthy: false, capabilities: definition.capabilities })
});

const registry = new Map<SocialProvider, SocialProviderAdapter>(
  SOCIAL_PROVIDERS.map(provider => [provider, adapterFor(definitions[provider])])
);

export const getSocialAdapter = (provider: string) => {
  const adapter = registry.get(provider as SocialProvider);
  if (!adapter) throw Object.assign(new Error("Unsupported social provider"), { code: "social_provider_unsupported", statusCode: 400 });
  return adapter;
};

export const listSocialAdapters = () => SOCIAL_PROVIDERS.map(provider => registry.get(provider)!);

export const validateSocialEnvironment = (provider: SocialProvider) => {
  const definition = definitions[provider];
  const missing = definition.requiredEnvironment.filter(name => !process.env[name]?.trim());
  const encryptionMissing = !process.env.GROWTH_SOCIAL_ENCRYPTION_KEY?.trim();
  return {
    available: !definition.futureReady && missing.length === 0 && !encryptionMissing,
    missing_environment: [...missing, ...(encryptionMissing ? ["GROWTH_SOCIAL_ENCRYPTION_KEY"] : [])],
    reason: definition.futureReady
      ? "Provider adapter reserved for future activation"
      : missing.length || encryptionMissing
        ? "Developer application configuration is incomplete"
        : "OAuth can be initiated; provider token exchange remains activation-gated"
  };
};

export const getSocialStartupStatus = () => SOCIAL_PROVIDERS.map(provider => ({
  provider,
  ...validateSocialEnvironment(provider)
}));
