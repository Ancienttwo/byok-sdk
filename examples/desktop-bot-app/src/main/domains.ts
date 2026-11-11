import type { MethodHandlers } from '../bridge/domain.ts';
import type { BridgeMethods, MainMethod } from '../bridge/protocol.ts';
import { keysMainHandlers, type KeysMainDependencies } from '../custody/main-handlers.ts';

/** What main's own handlers need from main: the Host bridge and the Host executable. */
export type MainDependencies = KeysMainDependencies;

/**
 * Main's answers to the renderer methods a bridge domain lists as `main`. A
 * domain that adds one fails to compile until its handler is connected here.
 */
export function createMainHandlers(deps: MainDependencies): MethodHandlers<Pick<BridgeMethods, MainMethod>> {
  return { ...keysMainHandlers(deps) };
}
