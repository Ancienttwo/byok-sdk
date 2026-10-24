// Built as its own private entry (`#byok-acp-runtime`): adapters load the ACP stack and its
// `@agentclientprotocol/sdk` dependency lazily, at session start, never at import.
export { SessionNotFoundError } from '../../vendor/oar/c88a514/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/c88a514/contracts/runtime-failure-error.js';
export { grokSession } from '../../vendor/oar/c88a514/runtimes/grok/session.js';
