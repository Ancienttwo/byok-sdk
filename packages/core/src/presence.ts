/**
 * Presence hints (§12.3).
 *
 * Presence is lossy, TTL-bounded, unsigned, and never authoritative. Expiry means
 * *absence*, not a stale value: a hint past its TTL is invisible to readers, so
 * nothing downstream can mistake an old level for a live one.
 *
 * These hints must never be used to derive coordination state, execution state,
 * authorization, billing, or recovery — which is why this module shares no
 * vocabulary with `board.ts` and no vocabulary with the frozen wire states. The
 * constraint test enforces that separation by scanning this file for those
 * names. A device that looks busy is not evidence that any particular work item
 * moved anywhere.
 *
 */
import type { TenantId } from './tenant';

/** The five presence levels. */
export const PRESENCE_LEVELS = ['online', 'thinking', 'working', 'error', 'offline'] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

/** Runtime facts observed by a daemon's real local probe. Omitted fields are unknown. */
export interface PresenceRuntimeFact {
  readonly id: string;
  readonly version?: string;
  readonly authPresent?: boolean;
}

/** Unexpired presence facts nested in the tenant aggregate. */
export interface TenantReadinessPresence {
  readonly level: PresenceLevel;
  readonly detail?: string;
  readonly configuredToolsets?: readonly string[];
  readonly clientVersion?: string;
  readonly protocolVersions?: readonly number[];
  readonly runtimes?: readonly PresenceRuntimeFact[];
  readonly observedAt: string;
  readonly expiresAt: string;
}

/** Durable device state plus its optional live observation, scoped to one tenant. */
export interface TenantReadinessDevice {
  readonly deviceId: string;
  readonly productId: string;
  readonly deviceName: string;
  /** Retained but invariant: revocation deletes the row, so this is never `true`. */
  readonly revoked: boolean;
  /** Omitted when absent/expired or when the durable device is revoked. */
  readonly presence?: TenantReadinessPresence;
}

/** SDK-owned tenant read model; this is observation, never an execution gate. */
export interface TenantReadiness {
  readonly tenantId: TenantId;
  readonly activePairedDeviceCount: number;
  /** Retained but invariant: always 0, since a revoked device leaves no row to count. */
  readonly revokedDeviceCount: number;
  readonly observedPresenceCount: number;
  readonly observedPresenceByLevel: Readonly<Record<PresenceLevel, number>>;
  readonly devices: readonly TenantReadinessDevice[];
}

/** A device-level hint. `expiresAt` is authoritative: past it, the hint does not exist. */
export interface PresenceHint {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly level: PresenceLevel;
  /** Free-form host label, bounded by the composition. Never parsed by core. */
  readonly detail?: string;
  /**
   * Logical MCP toolset IDs this daemon reported as configured. Discovery
   * only: local task acceptance remains the fail-closed authority. Omission
   * means legacy/unknown; an empty array means known-none.
   */
  readonly configuredToolsets?: readonly string[];
  /** The U4a Local Agent release version, when the daemon supplied it. */
  readonly clientVersion?: string;
  /** Protocol versions actually advertised by this daemon. */
  readonly protocolVersions?: readonly number[];
  /** Runtime/auth facts from a real local probe; unknown facts are omitted. */
  readonly runtimes?: readonly PresenceRuntimeFact[];
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface PresenceHintInput {
  readonly deviceId: string;
  readonly level: PresenceLevel;
  readonly detail?: string;
  /** Validated logical IDs only; executable connector definitions never belong here. */
  readonly configuredToolsets?: readonly string[];
  /** The U4a Local Agent release version, when available. */
  readonly clientVersion?: string;
  /** Protocol versions actually advertised by this daemon. */
  readonly protocolVersions?: readonly number[];
  /** Runtime/auth facts from a real local probe; unknown facts are omitted. */
  readonly runtimes?: readonly PresenceRuntimeFact[];
  /** Hint lifetime. §12.7.5 suggests 60-120s for presence. */
  readonly ttlMs: number;
  /** Minimum time between accepted publications for this device. `0` explicitly disables throttling. */
  readonly minimumIntervalMs: number;
}

/**
 * Presence port. Tenant-first, async.
 *
 * Reads filter expired hints out rather than returning them with a flag: an
 * expired hint is indistinguishable from one that was never written.
 */
export interface PresenceStore {
  publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
  read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
  list(tenant: TenantId): Promise<readonly PresenceHint[]>;
}
