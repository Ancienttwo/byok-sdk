// The vendored native dsh runtime talks to its own plugin over JSON lines, so it needs no ACP library.
export { dshSession } from '../../vendor/oar/0e92470/runtimes/dsh/session.js';
export { SessionNotFoundError } from '../../vendor/oar/0e92470/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/0e92470/contracts/runtime-failure-error.js';
export { UnsupportedOptionError } from '../../vendor/oar/0e92470/contracts/errors.js';
