/**
 * Public entry point of the conformance suite.
 *
 * Kept under `src/__tests__/` on purpose (sprint S2.3): the suite is not part
 * of the package's public API this slice. Packaging it as a subpath export for
 * out-of-repo compositions is S4A story O-005's decision, not something to
 * pre-commit to here.
 */
export { runCoreConformance, withComposition } from './harness';
export type { CoreCompositionFactory, CoreCompositionHandle } from './harness';
export { CORE_PORT_INTERFACES, CORE_PORT_METHODS } from './port-inventory';
