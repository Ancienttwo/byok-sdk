// Built as its own private entry (`#byok-acp-runtime`): adapters load the ACP stack and its
// `@agentclientprotocol/sdk` dependency lazily, at session start, never at import.
export { SessionNotFoundError } from '../../vendor/oar/044633e/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/044633e/contracts/runtime-failure-error.js';
export { grokSession } from '../../vendor/oar/044633e/runtimes/grok/session.js';
