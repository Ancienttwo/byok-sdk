import type { SupervisedHostState } from "../../src/bridge/protocol.ts";
import { toBridgeCallError } from "./bridge.ts";
import { formatNumber, t } from "./i18n.ts";

const BRIDGE_ERROR_KEYS = {
  PROVIDER_CONFIGURATION_BUSY: "error.PROVIDER_CONFIGURATION_BUSY",
  StaleApprovalError: "error.StaleApprovalError",
  custody_failed: "error.custody_failed",
  custody_exited: "error.custody_exited",
  custody_timeout: "error.custody_timeout",
  catalog_refresh_timeout: "error.catalog_refresh_timeout",
  catalog_refresh_failed: "error.catalog_refresh_failed",
  invalid_receipt: "error.invalid_receipt",
  command_failed: "error.command_failed",
  invalid_exit: "error.invalid_exit",
  precondition_failed: "error.precondition_failed",
  missing_snapshot: "error.missing_snapshot",
  host_stop_failed: "error.host_stop_failed",
  method_failed: "error.method_failed",
  bridge_version_mismatch: "error.bridge_version_mismatch",
  hello_required: "error.hello_required",
  unknown_method: "error.unknown_method",
  invalid_message: "error.invalid_message",
  host_exited: "error.host_exited",
  invalid_params: "error.invalid_params",
  unauthorized_method: "error.unauthorized_method",
  call_timeout: "error.call_timeout",
  contract_error: "error.contract_error",
  RECOVERY_IN_PROGRESS: "error.RECOVERY_IN_PROGRESS",
};

/** Bridge messages may contain diagnostic prose. Only a recognized code selects user-facing copy. */
export function errorText(code: string | undefined): string {
  const key = code !== undefined && Object.hasOwn(BRIDGE_ERROR_KEYS, code)
    ? BRIDGE_ERROR_KEYS[code as keyof typeof BRIDGE_ERROR_KEYS]
    : "error.method_failed";
  return t(key);
}

export function bridgeErrorText(error: unknown): string {
  return errorText(toBridgeCallError(error).code);
}

export function restartSeconds(host: Extract<SupervisedHostState, { state: "restarting" }>): string {
  return formatNumber(Math.ceil(host.inMs / 1000));
}

const FAILURE_KEYS: Readonly<Record<string, string>> = {
  auth: "failure.auth",
  unauthorized: "failure.unauthorized",
  quota: "failure.quota",
  rate_limited: "failure.rate_limited",
  billing: "failure.billing",
  model_unavailable: "failure.model_unavailable",
  input_too_large: "failure.input_too_large",
  invalid_request: "failure.invalid_request",
  overloaded: "failure.overloaded",
  provider: "failure.provider",
  runtime_exited: "failure.runtime_exited",
  limit_reached: "failure.limit_reached",
  output_schema: "failure.output_schema",
  unknown: "failure.unknown",
  agent_memory_resident_over_limit: "failure.agent_memory_resident_over_limit",
  agent_memory_resident_multiple_links: "failure.agent_memory_resident_multiple_links",
  agent_memory_resident_not_regular_file: "failure.agent_memory_resident_not_regular_file",
  agent_memory_resident_not_utf8: "failure.agent_memory_resident_not_utf8",
  agent_memory_snapshot_over_file_limit: "failure.agent_memory_snapshot_over_file_limit",
  agent_memory_snapshot_over_byte_limit: "failure.agent_memory_snapshot_over_byte_limit",
  agent_memory_snapshot_refused: "failure.agent_memory_snapshot_refused",
};

/** Some older projections expose a reason string. Only exact failure codes have display copy. */
export function failureText(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(FAILURE_KEYS, code) ? t(FAILURE_KEYS[code]!) : undefined;
}
