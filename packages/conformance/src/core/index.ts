/**
 * Entry point of the core conformance suite.
 *
 * S4A story O-005 answered the question the previous version of this header
 * left open: the suite is a private workspace package, not a subpath export of
 * `@byok-sdk/core`. Every composition it certifies (in-memory, Postgres + R2,
 * self-hosted server) lives in this repo, so publishing test machinery in a
 * shipped package would serve a consumer that does not exist.
 *
 * The port method table it used to re-export now lives in `@byok-sdk/core`'s
 * shipped source (`CORE_PORT_METHODS` / `CORE_PORT_INTERFACES`): it is contract
 * data both this package and core's own `constraints.test.ts` read, and keeping
 * it here would have meant a `core → conformance` devDependency cycle.
 */
export { runCoreConformance, withComposition } from './harness';
export type { CoreCompositionFactory, CoreCompositionHandle } from './harness';
