import type { RuntimeInfo, ToolsetId } from '@byok-sdk/protocol';

/**
 * What this process has OBSERVED about a device's live connection.
 *
 * This is not a second authority over anything durable. The device row
 * (`DeviceRecord`, `@byok-sdk/cloud`) owns identity and the capability list
 * every admission gate reads; the mailbox owns delivery. What lives here is the
 * part of `conn.hello` the kernel deliberately does not persist — the runtime
 * DISCOVERY block and the client's self-reported version/toolset inventory —
 * plus "when did we last hear from this device at all".
 *
 * Why the kernel does not persist it: `conn.hello.runtimes` describes what a
 * device build could run, changes on every daemon restart, and authorizes
 * nothing (the steer gate reads the CLAIM snapshot, never this). Storing it
 * durably would create a stale second description of a device that outlives the
 * process that saw it. Keeping it as an in-process observation is honest about
 * its lifetime: restart the server and it is gone, exactly like the connection
 * it describes.
 *
 * Presence is an expiring LEASE over `lastSeen`, not a stored flag and not "a
 * socket is open" — there are no sockets any more. Two observations renew it:
 * the device's own `conn.hello` over `POST /byok/messages`, and a
 * `GET /byok/events` poll (a device that is polling is present even if it never
 * announced). It lapses on its own once nothing has renewed it for
 * `presenceTtlMs` (see {@link DeviceConnections.isConnected}), and revocation
 * deletes the observation outright together with everything else scoped to the
 * device.
 */
export interface DeviceConnection {
  /** ISO-8601 instant of the most recent observation. */
  lastSeen: string;
  clientVersion?: string;
  runtimes?: RuntimeInfo[];
  configuredToolsets?: ToolsetId[];
}

/** `conn.hello`'s discovery half, as observed on one accepted announcement. */
export interface DeviceAnnouncement {
  readonly clientVersion?: string;
  readonly runtimes?: readonly RuntimeInfo[];
  readonly configuredToolsets?: readonly ToolsetId[];
}

export interface DeviceConnectionsOptions {
  /**
   * How long one observation keeps a device present, ms. Must outlast a full
   * long-poll hold plus the gap before the next poll: a poll renews the lease
   * once, when it starts, and nothing renews it while the poll is held.
   */
  readonly presenceTtlMs: number;
  /** Epoch-ms clock the lease is judged against. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * In-process device observations, in first-observation order.
 *
 * Insertion order is load-bearing for ambient dispatch selection
 * (`device-selection.ts`): "the first connected device" must be stable and
 * explainable, and a `Map` gives that for free without a second index.
 */
export class DeviceConnections {
  readonly #devices = new Map<string, DeviceConnection>();
  readonly #presenceTtlMs: number;
  readonly #now: () => number;

  constructor(options: DeviceConnectionsOptions) {
    this.#presenceTtlMs = options.presenceTtlMs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Record an accepted `conn.hello`. Discovery fields are REPLACED wholesale,
   * never merged: a daemon that restarted with a runtime removed must not keep
   * advertising it because an older hello mentioned it.
   */
  announce(deviceId: string, announcement: DeviceAnnouncement, at: string): void {
    this.#devices.set(deviceId, {
      lastSeen: at,
      ...(announcement.clientVersion === undefined ? {} : { clientVersion: announcement.clientVersion }),
      ...(announcement.runtimes === undefined ? {} : { runtimes: [...announcement.runtimes] }),
      ...(announcement.configuredToolsets === undefined
        ? {}
        : { configuredToolsets: [...announcement.configuredToolsets] }),
    });
  }

  /**
   * Record any other sign of life (an inbound envelope, a long-poll read).
   * Deliberately additive: it renews the lease by refreshing `lastSeen`
   * without touching the discovery block, because none of those signals carry
   * one and clearing it would lose what the last hello said.
   */
  touch(deviceId: string, at: string): void {
    const existing = this.#devices.get(deviceId);
    if (existing === undefined) {
      this.#devices.set(deviceId, { lastSeen: at });
      return;
    }
    existing.lastSeen = at;
  }

  get(deviceId: string): DeviceConnection | undefined {
    return this.#devices.get(deviceId);
  }

  /**
   * The one presence rule: observed within the last `presenceTtlMs`. Every
   * reader — `MachineInfo.connected`, ambient selection, the dispatch gate and
   * `stats().connectedDeviceCount` — asks this, so none can disagree.
   */
  isConnected(deviceId: string): boolean {
    const connection = this.#devices.get(deviceId);
    return connection !== undefined && this.#present(connection, this.#now());
  }

  connectedCount(): number {
    const now = this.#now();
    let count = 0;
    for (const connection of this.#devices.values()) if (this.#present(connection, now)) count += 1;
    return count;
  }

  #present(connection: DeviceConnection, now: number): boolean {
    return now - Date.parse(connection.lastSeen) <= this.#presenceTtlMs;
  }

  /** Device ids in first-observation order — the order ambient selection walks. */
  ids(): readonly string[] {
    return [...this.#devices.keys()];
  }

  /** Drop everything scoped to a device. Called when its registration is deleted (§6.3). */
  forget(deviceId: string): void {
    this.#devices.delete(deviceId);
  }

  clear(): void {
    this.#devices.clear();
  }
}
