// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpRows} CheckDshMcpRows */
export { dshMcpRows } from '../../vendor/oar/4eb5919/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/4eb5919/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/4eb5919/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/4eb5919/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/4eb5919/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/4eb5919/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/4eb5919/contracts/session-unavailable-error.js';
