// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpRows} CheckDshMcpRows */
export { dshMcpRows } from '../../vendor/oar/552a4f9/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/552a4f9/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/552a4f9/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/552a4f9/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/552a4f9/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/552a4f9/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/552a4f9/contracts/session-unavailable-error.js';
