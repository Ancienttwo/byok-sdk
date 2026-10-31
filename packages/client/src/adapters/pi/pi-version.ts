import { byok } from '../../../package.json';
import type { RuntimeVersionPolicy } from '../../types';

/**
 * The Pi runtime version this client bundles (#1103). The manifest's
 * `byok.piRuntimePin` is the only author; `readClientPiRuntimePin` projects it
 * for detection, and this constant names it for the version policy.
 */
export const QUALIFIED_PI_VERSION: string = byok.piRuntimePin;

/** The adapter's default policy (#1103): Pi is bundled at the pin, so a different token is not a warning. */
export const PI_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_PI_VERSION,
  unqualified: 'allow',
});
