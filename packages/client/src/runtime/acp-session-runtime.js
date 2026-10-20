// Built as its own private entry (`#byok-acp-runtime`): adapters load the ACP stack and its
// `@agentclientprotocol/sdk` dependency lazily, at session start, never at import.
export { SessionNotFoundError } from '../../vendor/oar/60ad09b/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/60ad09b/contracts/runtime-failure-error.js';
export { grokSession } from '../../vendor/oar/60ad09b/runtimes/grok/session.js';
