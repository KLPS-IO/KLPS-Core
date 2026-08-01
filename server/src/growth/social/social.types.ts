export const SOCIAL_PROVIDERS = [
  "linkedin", "facebook", "instagram", "x", "tiktok", "snapchat"
] as const;

export type SocialProvider = typeof SOCIAL_PROVIDERS[number];

export const SOCIAL_CAPABILITIES = [
  "text", "images", "video", "carousel", "stories", "reels", "threads",
  "clickable_links", "scheduling", "metrics", "comment_retrieval",
  "draft_upload", "direct_publishing"
] as const;

export type SocialCapability = typeof SOCIAL_CAPABILITIES[number];

export type ProviderEnvironment = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
};

export type ProviderSetupItem = {
  label: string;
  detail: string;
  status: "required" | "configured" | "external_review" | "future";
};

export type SocialProviderDefinition = {
  id: SocialProvider;
  name: string;
  developerAccount: string;
  applicationName: string;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  scopes: string[];
  capabilities: SocialCapability[];
  requiredEnvironment: string[];
  supportsPkce: boolean;
  externalReview: string[];
  futureReady?: boolean;
};

export type OAuthTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  providerAccountId: string;
  providerAccountName: string;
  providerAccountType: "member" | "organization";
  discoveredCapabilities: SocialCapability[];
  discoveredAssets: SocialDiscoveredAsset[];
};

export type SocialDiscoveredAsset = {
  provider: "facebook" | "instagram";
  providerAssetType: "page" | "instagram_professional";
  providerAssetId: string;
  providerAssetName: string;
  providerAssetUsername: string | null;
};

export type MetaOAuthDiagnosticDetails = {
  internal_error_code?: string;
  stage?: string;
  meta_http_status?: number;
  missing_permissions?: string[];
  page_found?: boolean;
  instagram_found?: boolean;
  database_error_category?: string;
};

export type MetaOAuthDiagnostics = {
  correlationId: string;
  emit: (event: string, details?: MetaOAuthDiagnosticDetails) => void;
};

export interface SocialProviderAdapter {
  readonly definition: SocialProviderDefinition;
  getEnvironment(): ProviderEnvironment;
  buildAuthorizationUrl(input: {
    state: string;
    codeChallenge?: string;
    redirectUri: string;
  }): string;
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
    diagnostics?: MetaOAuthDiagnostics;
  }): Promise<OAuthTokenResult>;
  refreshToken(refreshToken: string): Promise<OAuthTokenResult>;
  revokeToken(accessToken: string): Promise<void>;
  publish(): Promise<never>;
  checkHealth(accessToken: string): Promise<{ healthy: boolean; capabilities: SocialCapability[] }>;
}
