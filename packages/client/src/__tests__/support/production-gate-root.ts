import { setPosixGateRootForTests } from '../../util/path-mutation-gate';

/**
 * For a test file whose parent and child processes take the same gate: the
 * children run production code with the production root, so the parent must
 * lock there too or the two stop excluding each other. Call at module scope.
 */
export function useProductionGateRootForFile(): void {
  setPosixGateRootForTests(undefined);
}
