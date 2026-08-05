import crypto from "crypto";
import { MetaOAuthDiagnostics } from "./social.types";

const EVENTS=new Set([
  "x_oauth_callback_received","x_oauth_state_validated","x_oauth_state_rejected",
  "x_oauth_token_exchange_started","x_oauth_token_exchange_completed",
  "x_oauth_token_exchange_failed","x_oauth_identity_lookup_started",
  "x_oauth_identity_lookup_completed","x_oauth_identity_lookup_failed",
  "x_oauth_connection_persistence_started","x_oauth_connection_completed",
  "x_oauth_connection_persistence_failed","x_oauth_callback_redirected",
  "x_oauth_callback_redirected_with_error"
]);

export const createXOAuthDiagnostics=(
  correlationId:string=crypto.randomUUID(),
  sink?:(line:string) => void
):MetaOAuthDiagnostics => ({
  correlationId,
  emit(event,details={}) {
    if (!EVENTS.has(event)) return;
    const payload:Record<string,unknown>={event,correlation_id:correlationId,provider:"x"};
    if (details.stage) payload.stage=details.stage;
    if (Number.isInteger(details.x_http_status)) payload.x_http_status=details.x_http_status;
    if (details.x_error_category) payload.x_error_category=details.x_error_category;
    if (details.database_error_category) payload.database_error_category=details.database_error_category;
    if (typeof details.x_refresh_token_returned === "boolean") payload.x_refresh_token_returned=details.x_refresh_token_returned;
    const line=JSON.stringify(payload);
    if (sink) sink(line);
    else if (/(?:failed|error)$/.test(event)) console.warn(line);
    else console.info(line);
  }
});

const OAUTH_CATEGORIES=new Set([
  "invalid_request","invalid_client","invalid_grant","unauthorized_client",
  "unsupported_grant_type","invalid_scope"
]);

export const safeXOAuthCategory=(payload:unknown,status:number) => {
  if (payload && typeof payload === "object") {
    const value=(payload as Record<string,unknown>).error;
    if (typeof value === "string" && OAUTH_CATEGORIES.has(value)) return value;
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_server_error";
  if (status >= 400) return "provider_client_error";
  return "invalid_provider_response";
};
