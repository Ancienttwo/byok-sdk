// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpRows} CheckDshMcpRows */
export { dshMcpRows } from '../../vendor/oar/c0c8b28/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/c0c8b28/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/c0c8b28/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/c0c8b28/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/c0c8b28/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/c0c8b28/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/c0c8b28/contracts/session-unavailable-error.js';
export { dshSessionCapabilities } from '../../vendor/oar/c0c8b28/runtimes/dsh/session.js';
