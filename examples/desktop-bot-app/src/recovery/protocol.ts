/**
 * Main's handoff to Host executable recovery commands: main spawns it with
 * command-specific arguments and reads one receipt line from stdout.
 * Types and constants only, so main loads no SDK or store code through it.
 */
import type { Move } from './stores.ts';

export const START_FRESH_COMMAND = 'byok-desktop-start-fresh';
export const SNAPSHOT_COMMAND = 'byok-desktop-snapshot';
export const SNAPSHOT_STATUS_COMMAND = 'byok-desktop-snapshot-status';
export const RESTORE_COMMAND = 'byok-desktop-restore';

/** A file-name-safe timestamp for aside and staging names. */
export const stampOf = (date: Date): string => date.toISOString().replaceAll(':', '-');

/**
 * `code` is the SDK's `DeviceEnrollmentClearError` code, or `start_fresh_failed`.
 * `movedBack` is false only when a store could not be moved back after the failure.
 */
export type StartFreshReceipt =
  | { readonly ok: true; readonly moved: readonly Move[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly movedBack: boolean };

/** Receipt of {@link SNAPSHOT_COMMAND}: returns the finalized snapshot directory on success. */
export type SnapshotReceipt =
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Receipt of {@link SNAPSHOT_STATUS_COMMAND}: returns the complete snapshot entry for the queried version, or null. */
export type SnapshotStatusReceipt =
  | { readonly ok: true; readonly snapshot: { readonly version: string; readonly target: string } | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Receipt of {@link RESTORE_COMMAND}: returns the moved-aside current Host store path on success. */
export type RestoreReceipt =
  | { readonly ok: true; readonly asidePath: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly movedBack: boolean };
