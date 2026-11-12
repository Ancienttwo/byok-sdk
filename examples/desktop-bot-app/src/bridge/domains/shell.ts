/**
 * The shell bridge domain: what the window shows about the Host and the recovery
 * actions it offers (#1499 D3, D4; #1917). Main answers every method: it supervises
 * the Host, so it knows the state while no Host runs, and it stops the Host before
 * an action moves a store.
 */
import type { BridgeDomain } from '../domain.ts';
import type { SupervisedHostState } from '../protocol.ts';
import type { Move } from '../../recovery/stores.ts';

export interface ShellView {
  /** Main's last view of the Host; null until the first Host state arrived. */
  readonly host: SupervisedHostState | null;
  /** The complete snapshot this app version wrote before an update, which restore puts back; null when there is none. */
  readonly restore: { readonly version: string } | null;
}

export interface ShellMethods {
  'shell.state': { params: undefined; result: ShellView };
  /**
   * Stops the Host, moves the current stores aside (never deleting them), copies the
   * snapshot of this app version back and relaunches the app. Refused without a
   * complete snapshot of this version.
   */
  'shell.restore': { params: undefined; result: { asidePath: string } };
  /**
   * Offered only while the Host is stopped on a refused store: stops the Host, moves
   * the SDK store, the Host stores (with their snapshots) and the Agent homes aside,
   * clears the old device enrollment, and relaunches the app, which pairs a new
   * device. A refusal moves everything back.
   */
  'shell.startFresh': { params: undefined; result: { moved: readonly Move[] } };
}

export const SHELL_DOMAIN = {
  renderer: [],
  main: ['shell.state', 'shell.restore', 'shell.startFresh'],
} as const satisfies BridgeDomain<ShellMethods>;
