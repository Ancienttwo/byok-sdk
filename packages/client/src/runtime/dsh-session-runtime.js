// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
/** @typedef {import('../../../../scripts/api-surface/oar-bridge-types').CheckDshMcpConfigs} CheckDshMcpConfigs */
export { dshMcpConfigs } from '../../vendor/oar/19ccd9a/runtimes/dsh/mcp.js';
export { dshSession } from '../../vendor/oar/19ccd9a/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/19ccd9a/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/19ccd9a/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/19ccd9a/contracts/errors.js';
export { ModelConfirmationError } from '../../vendor/oar/19ccd9a/contracts/model-confirmation-error.js';
export { SessionUnavailableError } from '../../vendor/oar/19ccd9a/contracts/session-unavailable-error.js';
export { dshSessionCapabilities } from '../../vendor/oar/19ccd9a/runtimes/dsh/session.js';
