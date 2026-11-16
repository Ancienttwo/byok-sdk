/**
 * Hard cap on one newline-delimited JSON-RPC frame, shared by the SDK's MCP
 * client read buffer and its stdio and HTTP servers' outbound frames, so an SDK
 * server and an SDK client agree on one ceiling in both directions. A peer that
 * never emits a newline cannot make the reader accumulate without limit.
 */
export const MCP_MAX_FRAME_BYTES = 1_048_576;
