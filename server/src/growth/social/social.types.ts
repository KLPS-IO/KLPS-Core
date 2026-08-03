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
  facebookConfigId?: string;
};

export type MetaGrantMode = "explicit_scope" | "business_configuration";

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
  futurePermissions?: string[];
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
  grant_mode?: MetaGrantMode;
  config_id_configured?: boolean;
  internal_error_code?: string;
  stage?: string;
  meta_http_status?: number;
  missing_permissions?: string[];
  page_found?: boolean;
  instagram_found?: boolean;
  database_error_category?: string;
  provider_error_type?: string;
  provider_error_code?: number;
  provider_error_subcode?: number;
  provider_error_transient?: boolean;
  provider_diagnosis?: MetaProviderDiagnosis;
  graph_version?: string;
  graph_endpoint?: string;
  managed_pages_count?: number;
  returned_pages_count?: number;
  discarded_pages_count?: number;
  page_name?: string;
  page_id?: string;
  page_access_token_exists?: boolean;
  instagram_business_account_exists?: boolean;
};

export type MetaProviderDiagnosis =
  | "invalid_client_credentials"
  | "redirect_uri_mismatch"
  | "invalid_or_expired_code"
  | "code_already_used"
  | "app_configuration_error"
  | "provider_request_invalid"
  | "provider_token_failure_unclassified";

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
