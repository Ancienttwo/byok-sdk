/**
 * `@byok-sdk/client/assertion-client` — the assertion request surface for a
 * sibling local process, without the daemon graph.
 *
 * A Host toolset server is the shape this entry exists for: a short-lived
 * stdio process the daemon spawns for one task, whose entire job is to take the
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce it was started with, ask the running daemon
 * for one short-lived task assertion, and present it to the product's cloud.
 * It never runs a daemon, never drives a coding-agent runtime, and never
 * touches the transport.
 *
 * Importing `requestTaskAssertion` from the package root gave it all three
 * anyway. The root entry composes `createDaemon`, which reaches
 * `@earendil-works/pi-coding-agent` and, through it, `@modelcontextprotocol/sdk`
 * and `ajv` — and the root graph's top-level `@modelcontextprotocol/client`
 * import carries a dist that embeds an `ajv` provider built on `new Function`.
 * A host that runs its toolset servers under a CSP, a locked-down runtime, or
 * any policy that refuses runtime code generation could not use the function it
 * needed because of code it never called.
 *
 * So this entry re-exports exactly the two request functions and their public
 * option/result types from `../daemon/assertion-client`, whose own transitive
 * imports are only `@byok-sdk/core`, `@byok-sdk/protocol`,
 * `../bin/control-client`, `../daemon/control-protocol` and `../daemon/store`
 * (plus `zod` through core's protocol types). Nothing else may be added here.
 *
 * Two things are deliberately absent, and this file is the record of why.
 *
 * 1. The control client. `connectControlClient`/`ControlClient` are not
 *    exported from this package at all (see `src/index.ts` and
 *    `../daemon/assertion-client`'s own doc comment) and must not become
 *    reachable here: the same socket also carries `shutdown`, approval
 *    resolution, and the raw task-event stream. A caller that needs one
 *    capability gets one function.
 *
 * 2. Everything else on the root entry. This is not a second package index.
 *    `__tests__/dist-subpath-closure.test.ts` walks the built bundle and fails
 *    on any import specifier that is not a node builtin, `@byok-sdk/core`,
 *    `@byok-sdk/protocol`, or a relative path, and on any trace of `ajv`,
 *    `pi-coding-agent`, `@modelcontextprotocol/client`, or runtime code
 *    generation.
 *
 * The root entry still exports these two functions and keeps doing so; this
 * entry is a narrower door to the same authority, not a replacement for it.
 */

/** Asks a running daemon for one short-lived task assertion bound to the caller's `BYOK_HOST_TOOLSET_CONTEXT` nonce. */
export { requestTaskAssertion } from '../daemon/assertion-client';
/** Asks a running daemon for one short-lived device assertion scoped to an allowlisted audience. */
export { requestDeviceAssertion } from '../daemon/assertion-client';

/** Everything `requestTaskAssertion` needs: the daemon's `productId`/`storeDir`, the context nonce, the exact audience, and an optional round-trip bound. */
export type { RequestTaskAssertionOptions } from '../daemon/assertion-client';
/** The daemon's nine refusal codes plus `unavailable` and `bad_response`, kept as an open string union so a newer daemon's code surfaces verbatim. */
export type { RequestTaskAssertionErrorCode } from '../daemon/assertion-client';
/** Typed result: a parsed `TaskAssertionEnvelopeV1` with its expiry, or a refusal code and reason. Never throws for an expected outcome. */
export type { RequestTaskAssertionResult } from '../daemon/assertion-client';

/** Everything `requestDeviceAssertion` needs: the daemon's `productId`/`storeDir`, the exact audience, and an optional round-trip bound. */
export type { RequestDeviceAssertionOptions } from '../daemon/assertion-client';
/** The daemon's six refusal codes plus `unavailable` and `bad_response`, kept as an open string union for the same reason. */
export type { RequestDeviceAssertionErrorCode } from '../daemon/assertion-client';
/** Typed result: a parsed `DeviceAssertionEnvelopeV1` with its expiry, or a refusal code and reason. Never throws for an expected outcome. */
export type { RequestDeviceAssertionResult } from '../daemon/assertion-client';
