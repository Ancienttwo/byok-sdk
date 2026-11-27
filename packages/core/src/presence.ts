import type { CollectExpiredInput, CollectExpiredResult } from './retention.js';
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
import type { TenantId } from './tenant.js';

/** The five presence levels. */
export const PRESENCE_LEVELS = ['online', 'thinking', 'working', 'error', 'offline'] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

/**
 * The capability matrix a daemon reported for one runtime: the shape of
 * `@byok-sdk/protocol`'s `RuntimeCapabilities` (#1103). Omitted fields are unknown.
 */
export interface PresenceRuntimeCapabilities {
  readonly steer?: boolean;
  readonly images?: boolean;
  readonly resume?: boolean;
  readonly approvalInteractive?: boolean;
  readonly mcpToolsets?: boolean;
  readonly messageDraft?: boolean;
  readonly toolAuthorizationAuto?: boolean;
  readonly durableLane?: boolean;
  readonly preparedLane?: boolean;
  readonly selectionModes: readonly string[];
  readonly defaultModelModes?: readonly ('byok' | 'adapter-model' | 'byok-profile')[];
  readonly effort: boolean;
  readonly serviceTier?: boolean;
  readonly serviceTierFallback?: boolean;
  readonly byokProviderId?: string;
  readonly isolation?: {
    readonly userInstructions?: boolean;
    readonly userOutputStyle?: boolean;
    readonly userMemory?: boolean;
    readonly userSkills?: boolean;
    readonly userHookContext?: boolean;
    readonly userMcpServers?: boolean;
    readonly sessionPersistence?: boolean;
  };
}

/** Executor facts observed by a daemon's local scan. */
export interface PresenceHarnessFact {
  readonly id: string;
  readonly version?: string;
  readonly authPresent?: boolean;
  readonly capabilities: PresenceRuntimeCapabilities;
  readonly versionPolicy?: { readonly state: 'allow' | 'warn' | 'block'; readonly qualifiedVersion?: string };
}

/** Copies the defined boolean flags named by `keys`; a stored row holds no other keys. */
function definedFlags<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const flags: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) flags[key] = source[key];
  return flags as Pick<T, K>;
}

/** A frozen copy of one runtime fact holding only the known fields; every presence store returns this. */
export function freezePresenceHarnessFact(runtime: PresenceHarnessFact): PresenceHarnessFact {
  const capabilities = runtime.capabilities;
  return Object.freeze({
    id: runtime.id,
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
    ...(runtime.authPresent === undefined ? {} : { authPresent: runtime.authPresent }),
    capabilities: Object.freeze({
      ...definedFlags(capabilities, ['steer', 'images', 'resume', 'approvalInteractive', 'mcpToolsets', 'messageDraft', 'toolAuthorizationAuto', 'durableLane', 'preparedLane']),
      selectionModes: Object.freeze([...capabilities.selectionModes]),
      ...(capabilities.defaultModelModes === undefined ? {} : { defaultModelModes: Object.freeze([...capabilities.defaultModelModes]) }),
      effort: capabilities.effort,
      ...definedFlags(capabilities, ['serviceTier', 'serviceTierFallback']),
      ...(capabilities.byokProviderId === undefined ? {} : { byokProviderId: capabilities.byokProviderId }),
      ...(capabilities.isolation === undefined ? {} : {
        isolation: Object.freeze(definedFlags(capabilities.isolation, ['userInstructions', 'userOutputStyle', 'userMemory', 'userSkills', 'userHookContext', 'userMcpServers', 'sessionPersistence'])),
      }),
    }),
    ...(runtime.versionPolicy === undefined ? {} : { versionPolicy: Object.freeze({ ...runtime.versionPolicy }) }),
  });
}

/** Unexpired presence facts nested in the tenant aggregate. */
export interface TenantReadinessPresence {
  readonly level: PresenceLevel;
  readonly detail?: string;
  readonly configuredToolsets?: readonly string[];
  readonly clientVersion?: string;
  readonly protocolVersions?: readonly number[];
  readonly harnesses?: readonly PresenceHarnessFact[];
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
   * means unknown; an empty array means known-none.
   */
  readonly configuredToolsets?: readonly string[];
  /** The U4a Local Agent release version, when the daemon supplied it. */
  readonly clientVersion?: string;
  /** Protocol versions actually advertised by this daemon. */
  readonly protocolVersions?: readonly number[];
  /** Executor facts from the device scan. */
  readonly harnesses?: readonly PresenceHarnessFact[];
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
  /** Executor facts from the device scan. */
  readonly harnesses?: readonly PresenceHarnessFact[];
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
  collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
  publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
  read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
  list(tenant: TenantId): Promise<readonly PresenceHint[]>;
  /** Deletes this tenant's hint for `deviceId`; a no-op when there is none. Called by device retirement. */
  deleteDevice(tenant: TenantId, deviceId: string): Promise<void>;
}
