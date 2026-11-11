import type { MethodHandlers } from '../bridge/domain.ts';
import type { BridgeMethods, MainMethod } from '../bridge/protocol.ts';

/**
 * Main's answers to the renderer methods a bridge domain lists as `main`. A
 * domain that adds one fails to compile until its handler is connected here.
 */
export const MAIN_HANDLERS: MethodHandlers<Pick<BridgeMethods, MainMethod>> = {};
