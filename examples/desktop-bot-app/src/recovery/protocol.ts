/**
 * Main's handoff to the Host executable's start fresh command: main spawns it with
 * the aside stamp as its one argument and reads one receipt line from stdout.
 * Types only, so main loads no SDK code through it.
 */
import type { Move } from './stores.ts';

export const START_FRESH_COMMAND = 'byok-desktop-start-fresh';

/**
 * `code` is the SDK's `DeviceEnrollmentClearError` code, or `start_fresh_failed`.
 * `movedBack` is false only when a store could not be moved back after the failure.
 */
export type StartFreshReceipt =
  | { readonly ok: true; readonly moved: readonly Move[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly movedBack: boolean };
