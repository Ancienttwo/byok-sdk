/**
 * The SDK's shared MCP core.
 *
 * One connection/observation/projection authority for every MCP consumer in
 * this package. Nothing here imports a runtime: the core knows about stdio MCP
 * servers and nothing about Pi, claude or codex, which is what lets the
 * ordinary extension and the prepared launch entry project the same tools from
 * the same observation instead of each deriving their own.
 */
export {
  McpAuthorityError,
  McpStdioClient,
  McpTransportError,
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  MCP_MAX_FRAME_BYTES,
  MCP_OBSERVATION_MAX_STDOUT_BYTES,
} from './client';
export type { McpStdioClientOptions, McpStdioServerSpec } from './client';

export {
  classifyMcpToolsetServerObservation,
  diffMcpObservation,
  jsonEquals,
  observeMcpServer,
  GRANTABLE_MCP_SERVER_NAME,
  GRANTABLE_TOOL_NAME,
} from './observation';
export type {
  McpClassifiedToolDescriptor,
  McpObservationDrift,
  McpObservationDriftReason,
  McpServerObservation,
  McpToolDescriptor,
  McpToolsetServerObservation,
  ObserveMcpServerOptions,
} from './observation';

export {
  filterMcpObservationForPolicy,
  mcpToolsetToolNames,
  projectMcpTools,
  qualifiedMcpToolName,
} from './projection';
export type {
  McpLaunchProjection,
  McpObservationPolicyResolution,
  McpToolProjection,
} from './projection';
