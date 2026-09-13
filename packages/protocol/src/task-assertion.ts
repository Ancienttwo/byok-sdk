/**
 * The device-level half of the task lane's capability gate (contract §8.1).
 *
 * Contract §8.1 fixes ONE name, `host-mcp-task-context`, carried on two
 * independent channels that must both be in place before a host may route a
 * tool invocation through the task lane:
 *
 * 1. **Deployment level** — the ADR-010 `CapabilityDeclarationSchema` a
 *    deployment serves (`@byok-sdk/cloud`'s `CLOUD_CAPABILITIES`). §8.2(1)
 *    governs it: a deployment declares the capability only once it is
 *    completely implemented.
 * 2. **Device level** — this constant: a `conn.hello` capability string a host
 *    consumes through `declaresCapabilities`. §8.3 governs it: a device whose
 *    build cannot serve the lane simply does not advertise it, and the host
 *    answers `unavailable` rather than reaching for the device assertion the
 *    task lane does not accept.
 *
 * It lives in `@byok-sdk/protocol` for the same reason every other daemon
 * capability flag does: this package is the wire vocabulary both sides compile
 * against, and a name spelled twice is a name that can drift. It is registered
 * in `CAPABILITY_FLAGS` (`./version`), which is what makes it a value a daemon
 * can actually send.
 *
 * The spelling satisfies `@byok-sdk/core`'s `CAPABILITY_NAME_PATTERN`
 * (`/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/`) on purpose: the deployment-level channel
 * carries this exact literal, so a name legal in only one of the two channels
 * would leave them naming different things.
 */

/** Contract §8.1's capability gate for `byok-task-assertion-v1` tool authority. */
export const HOST_MCP_TASK_CONTEXT_CAPABILITY = 'host-mcp-task-context' as const;
