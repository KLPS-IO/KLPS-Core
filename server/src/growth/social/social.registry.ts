import {
  SOCIAL_PROVIDERS,
  SocialProvider,
  SocialProviderAdapter,
  SocialProviderDefinition
} from "./social.types";
import { exchangeLinkedInAuthorizationCode } from "./linkedin.adapter";
import { exchangeTikTokAuthorizationCode } from "./tiktok.adapter";
import {
  checkMetaIdentityHealth,
  exchangeMetaAuthorizationCode
} from "./meta.adapter";
import { getFacebookBusinessConfigurationStatus } from "./meta.diagnostics";

const definitions: Record<SocialProvider, SocialProviderDefinition> = {
  linkedin: {
    id: "linkedin", name: "LinkedIn",
    developerAccount: "LinkedIn Developer account",
    applicationName: "LinkedIn application with Sign In with LinkedIn using OpenID Connect",
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid","profile"],
    capabilities: [],
    requiredEnvironment: ["LINKEDIN_CLIENT_ID","LINKEDIN_CLIENT_SECRET","LINKEDIN_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: ["Enable Sign In with LinkedIn using OpenID Connect. Publishing products and permissions are not required for this connection."]
  },
  facebook: {
    id: "facebook", name: "Meta Identity",
    developerAccount: "Meta for Developers account",
    applicationName: "Meta application for founder identity and business account discovery",
    authorizationUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    scopes: ["public_profile","pages_show_list","instagram_basic"],
    capabilities: [],
    requiredEnvironment: ["META_CLIENT_ID","META_CLIENT_SECRET","META_FACEBOOK_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: [
      "Complete Meta Business verification where required.",
      "Request only pages_show_list and instagram_basic for Page and Instagram professional identity discovery."
    ]
  },
  instagram: {
    id: "instagram", name: "Instagram Professional",
    developerAccount: "Meta for Developers account",
    applicationName: "Discovered through Meta",
    authorizationUrl: null,
    tokenUrl: null,
    scopes: [],
    capabilities: [],
    requiredEnvironment: [],
    supportsPkce: false,
    externalReview: ["Discovered through Meta. A separate Instagram OAuth connection is not supported."],
    futureReady: true
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
    scopes: ["user.info.basic"],
    futurePermissions: ["video.upload","video.publish"],
    capabilities: [],
    requiredEnvironment: ["TIKTOK_CLIENT_KEY","TIKTOK_CLIENT_SECRET","TIKTOK_REDIRECT_URI"],
    supportsPkce: false,
    externalReview: [
      "Content Posting permissions video.upload and video.publish await separate provider approval and capability activation."
    ]
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
      : process.env.META_INSTAGRAM_REDIRECT_URI,
    facebookConfigId:provider === "facebook" ? process.env.META_FACEBOOK_CONFIG_ID : undefined
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
    if (definition.id === "facebook") {
      const configuration=getFacebookBusinessConfigurationStatus();
      if (!configuration.valid) {
        throw Object.assign(new Error("Meta business configuration is invalid"),{
          code:"social_provider_configuration_invalid",statusCode:409
        });
      }
      if (configuration.active) {
        url.searchParams.set("config_id",environment.facebookConfigId!);
      } else {
        url.searchParams.set("scope",definition.scopes.join(" "));
      }
    } else {
      url.searchParams.set("scope", definition.scopes.join(definition.id === "tiktok" ? "," : " "));
    }
    url.searchParams.set("state", state);
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  },
  exchangeAuthorizationCode: async input => {
    if (definition.id === "linkedin") {
      return exchangeLinkedInAuthorizationCode(definition, providerEnv(definition.id), input);
    }
    if (definition.id === "facebook") {
      return exchangeMetaAuthorizationCode(definition, providerEnv(definition.id), input);
    }
    if (definition.id === "tiktok") {
      return exchangeTikTokAuthorizationCode(definition,providerEnv(definition.id),input);
    }
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
  checkHealth: async accessToken => definition.id === "facebook"
    ? checkMetaIdentityHealth(accessToken)
    : { healthy: false, capabilities: definition.capabilities }
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
  const facebookConfiguration=provider === "facebook"
    ? getFacebookBusinessConfigurationStatus()
    : null;
  return {
    available: !definition.futureReady && missing.length === 0 && !encryptionMissing &&
      facebookConfiguration?.valid !== false,
    missing_environment: [...missing, ...(encryptionMissing ? ["GROWTH_SOCIAL_ENCRYPTION_KEY"] : [])],
    reason: provider === "instagram"
      ? "Discovered through Meta"
      : definition.futureReady
      ? "Provider adapter reserved for future activation"
      : facebookConfiguration?.valid === false
        ? "Facebook Login for Business configuration is malformed"
      : missing.length || encryptionMissing
        ? "Developer application configuration is incomplete"
        : provider === "linkedin" || provider === "facebook" || provider === "tiktok"
          ? "OAuth connection is configured"
          : "OAuth can be initiated; provider token exchange remains activation-gated"
  };
};

export const getSocialStartupStatus = () => SOCIAL_PROVIDERS.map(provider => ({
  provider,
  ...validateSocialEnvironment(provider)
})); 
