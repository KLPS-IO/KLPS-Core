import crypto from "crypto";
import {
  MetaOAuthDiagnosticDetails,
  MetaOAuthDiagnostics,
  MetaProviderDiagnosis
} from "./social.types";

type DiagnosticSink = (line: string) => void;

const failureEvent = (event: string) =>
  /(?:failed|rejected|missing|error)$/.test(event);

export const createMetaOAuthDiagnostics = (
  correlationId:string = crypto.randomUUID(),
  sink?: DiagnosticSink
): MetaOAuthDiagnostics => ({
  correlationId,
  emit(event: string, details: MetaOAuthDiagnosticDetails = {}) {
    const payload:Record<string,unknown> = {
      event,
      correlation_id:correlationId,
      provider:"facebook"
    };
    if (details.grant_mode) payload.grant_mode=details.grant_mode;
    if (typeof details.config_id_configured === "boolean") {
      payload.config_id_configured=details.config_id_configured;
    }
    if (details.internal_error_code) payload.internal_error_code=details.internal_error_code;
    if (details.stage) payload.stage=details.stage;
    if (Number.isInteger(details.meta_http_status)) payload.meta_http_status=details.meta_http_status;
    if (details.missing_permissions) payload.missing_permissions=details.missing_permissions;
    if (typeof details.page_found === "boolean") payload.page_found=details.page_found;
    if (typeof details.instagram_found === "boolean") payload.instagram_found=details.instagram_found;
    if (details.database_error_category) payload.database_error_category=details.database_error_category;
    if (details.provider_error_type) payload.provider_error_type=details.provider_error_type;
    if (Number.isInteger(details.provider_error_code)) payload.provider_error_code=details.provider_error_code;
    if (Number.isInteger(details.provider_error_subcode)) payload.provider_error_subcode=details.provider_error_subcode;
    if (typeof details.provider_error_transient === "boolean") payload.provider_error_transient=details.provider_error_transient;
    if (details.provider_diagnosis) payload.provider_diagnosis=details.provider_diagnosis;
    if (details.graph_version) payload.graph_version=details.graph_version;
    if (details.graph_endpoint) payload.graph_endpoint=details.graph_endpoint;
    if (Number.isInteger(details.managed_pages_count)) payload.managed_pages_count=details.managed_pages_count;
    if (Number.isInteger(details.returned_pages_count)) payload.returned_pages_count=details.returned_pages_count;
    if (Number.isInteger(details.discarded_pages_count)) payload.discarded_pages_count=details.discarded_pages_count;
    // Asset identifiers are available only during an explicitly enabled,
    // temporary diagnostic window. They remain excluded from normal logs.
    if (process.env.META_ASSET_DISCOVERY_DIAGNOSTICS === "true") {
      if (details.page_name) payload.page_name=details.page_name;
      if (details.page_id) payload.page_id=details.page_id;
    }
    if (typeof details.page_access_token_exists === "boolean") payload.page_access_token_exists=details.page_access_token_exists;
    if (typeof details.instagram_business_account_exists === "boolean") payload.instagram_business_account_exists=details.instagram_business_account_exists;
    const line = JSON.stringify(payload);
    if (sink) sink(line);
    else if (failureEvent(event)) console.warn(line);
    else console.info(line);
  }
});

const safeInteger = (value: unknown) => Number.isInteger(value) ? value as number : undefined;
const safeType = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
    ? value
    : undefined;

export const classifyMetaProviderError = (
  code?: number,
  subcode?: number
): MetaProviderDiagnosis => {
  if (code === 101 || code === 102) return "invalid_client_credentials";
  if (code === 191) return "redirect_uri_mismatch";
  if (code === 190 && subcode === 36001) return "code_already_used";
  if (code === 190) return "invalid_or_expired_code";
  if (code === 1 || code === 2) return "app_configuration_error";
  if (code === 100) return "provider_request_invalid";
  return "provider_token_failure_unclassified";
};

export const safeMetaProviderError = (payload: unknown): MetaOAuthDiagnosticDetails => {
  if (!payload || typeof payload !== "object") {
    return { provider_diagnosis:"provider_token_failure_unclassified" };
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return { provider_diagnosis:"provider_token_failure_unclassified" };
  }
  const source = error as Record<string, unknown>;
  const code = safeInteger(source.code);
  const subcode = safeInteger(source.error_subcode);
  return {
    provider_error_type:safeType(source.type),
    provider_error_code:code,
    provider_error_subcode:subcode,
    provider_error_transient:typeof source.is_transient === "boolean" ? source.is_transient : undefined,
    provider_diagnosis:classifyMetaProviderError(code,subcode)
  };
};

const fingerprint = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0,10);

export const getMetaConfigurationDiagnostics = () => {
  const clientId=process.env.META_CLIENT_ID ?? "";
  const secret=process.env.META_CLIENT_SECRET ?? "";
  const redirect=process.env.META_FACEBOOK_REDIRECT_URI ?? "";
  const configIdStatus=getFacebookBusinessConfigurationStatus();
  const expected="https://klps-lema-production.up.railway.app/api/growth/social/oauth/facebook/callback";
  return {
    event:"meta_oauth_configuration",
    meta_client_id_configured:Boolean(clientId.trim()),
    meta_secret_configured:Boolean(secret.trim()),
    meta_redirect_configured:Boolean(redirect.trim()),
    meta_redirect_equals_expected:redirect===expected,
    facebook_config_id_configured:configIdStatus.configured,
    facebook_business_configuration_mode:configIdStatus.active ? "active" : "inactive",
    facebook_config_id_valid:configIdStatus.valid,
    facebook_config_id_fingerprint:configIdStatus.fingerprint,
    meta_client_id_fingerprint:clientId ? fingerprint(clientId) : null,
    meta_secret_fingerprint:secret ? fingerprint(secret) : null
  };
};

const metaConfigurationIdPattern = /^[1-9][0-9]{4,31}$/;

export const getFacebookBusinessConfigurationStatus = () => {
  const raw=process.env.META_FACEBOOK_CONFIG_ID;
  const configured=raw !== undefined && raw.length > 0;
  const valid=!configured || (
    raw === raw?.trim() && metaConfigurationIdPattern.test(raw)
  );
  return {
    configured,
    valid,
    active:configured && valid,
    fingerprint:configured && valid ? fingerprint(raw!) : null
  };
};

export const safeDatabaseErrorCategory = (reason: unknown) => {
  const code = typeof reason === "object" && reason && "code" in reason &&
    typeof reason.code === "string" ? reason.code : "";
  if (code.startsWith("23")) return "constraint_violation";
  if (code.startsWith("08") || code === "ETIMEDOUT") return "connection_failure";
  if (code === "40001" || code === "40P01") return "transaction_retryable";
  return "database_operation_failed";
};
