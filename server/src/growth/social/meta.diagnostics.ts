import crypto from "crypto";
import { MetaOAuthDiagnosticDetails, MetaOAuthDiagnostics } from "./social.types";

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
    if (details.internal_error_code) payload.internal_error_code=details.internal_error_code;
    if (details.stage) payload.stage=details.stage;
    if (Number.isInteger(details.meta_http_status)) payload.meta_http_status=details.meta_http_status;
    if (details.missing_permissions) payload.missing_permissions=details.missing_permissions;
    if (typeof details.page_found === "boolean") payload.page_found=details.page_found;
    if (typeof details.instagram_found === "boolean") payload.instagram_found=details.instagram_found;
    if (details.database_error_category) payload.database_error_category=details.database_error_category;
    const line = JSON.stringify(payload);
    if (sink) sink(line);
    else if (failureEvent(event)) console.warn(line);
    else console.info(line);
  }
});

export const safeDatabaseErrorCategory = (reason: unknown) => {
  const code = typeof reason === "object" && reason && "code" in reason &&
    typeof reason.code === "string" ? reason.code : "";
  if (code.startsWith("23")) return "constraint_violation";
  if (code.startsWith("08") || code === "ETIMEDOUT") return "connection_failure";
  if (code === "40001" || code === "40P01") return "transaction_retryable";
  return "database_operation_failed";
};
