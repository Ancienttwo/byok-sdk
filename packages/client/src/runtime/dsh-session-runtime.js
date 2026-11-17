// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpRows} CheckDshMcpRows */
export { dshMcpRows } from '../../vendor/oar/bc1b2ac/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/bc1b2ac/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/bc1b2ac/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/bc1b2ac/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/bc1b2ac/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/bc1b2ac/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/bc1b2ac/contracts/session-unavailable-error.js';
