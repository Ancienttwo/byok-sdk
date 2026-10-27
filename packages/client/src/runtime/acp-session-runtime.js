// Built as its own private entry (`#byok-acp-runtime`): adapters load the ACP stack and its
// `@agentclientprotocol/sdk` dependency lazily, at session start, never at import.
export { SessionNotFoundError } from '../../vendor/oar/51b83c9/contracts/session-not-found-error.js';
export { RuntimeFailureError } from '../../vendor/oar/51b83c9/contracts/runtime-failure-error.js';
export { grokSession } from '../../vendor/oar/51b83c9/runtimes/grok/session.js';
