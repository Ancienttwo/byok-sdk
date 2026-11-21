// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpRows} CheckDshMcpRows */
export { dshMcpRows } from '../../vendor/oar/4f767ca/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/4f767ca/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/4f767ca/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/4f767ca/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/4f767ca/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/4f767ca/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/4f767ca/contracts/session-unavailable-error.js';
export { dshSessionCapabilities } from '../../vendor/oar/4f767ca/runtimes/dsh/session.js';
