import type { ByokCloud } from '@byok-sdk/cloud';
import type { HostedCollaborationStore } from './store';

type TenantReadiness = Awaited<ReturnType<ByokCloud['readTenantReadiness']>>;

/** The SDK device read of one tenant: the SDK `readTenantReadiness`, the read behind L's `machines.list`. */
export interface HostedDevicePort {
  readiness(): Promise<Pick<TenantReadiness, 'devices'>>;
}
export interface DeviceObserverOptions {
  /** The SDK calls of the tenant that owns `scope`. */
  port: (scope: string) => HostedDevicePort;
  /** How long the read may take, 1 s as in L. A read that takes longer writes nothing. */
  timeoutMs?: number;
  /** The clock that the observation reads under the scope lock. */
  now?: () => number;
}

/**
 * The `connected` fact of each device of a readiness read, as the server's `machines.list` gives it to L: a device is connected
 * when it has unexpired presence.
 */
export function connectedDevices(readiness: Pick<TenantReadiness, 'devices'>): Map<string, boolean> {
  return new Map(readiness.devices.map(device => [device.deviceId, device.presence !== undefined]));
}

/**
 * The H device observation (#793 S11), as L's `refreshDevices`: when a delegation of `scope` can change, one SDK readiness
 * read outside any transaction, then the K8 `observeDevices` rule under the scope lock. Presence is display only. A read
 * that throws or times out writes nothing, as in L; a store error propagates. The deployment runs it from its due scheduler
 * `sync`, before `store.sync`. It has no due time of its own, so a waiting delegation's display can lag until its scope's
 * next sync, where L polls on each pass.
 */
export class HostedDeviceObserver {
  private readonly now: () => number;
  constructor(private readonly store: HostedCollaborationStore, private readonly options: DeviceObserverOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Observes the devices of `scope`, and returns how many delegations changed. */
  async observe(scope: string): Promise<number> {
    if (!await this.store.awaitsDevice(scope)) return 0;
    const devices = await this.read(scope);
    return devices ? this.store.observeDevices(scope, devices, this.now) : 0;
  }

  private async read(scope: string): Promise<Map<string, boolean> | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return connectedDevices(await Promise.race([this.options.port(scope).readiness(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('device_read_timeout')), this.options.timeoutMs ?? 1000); })]));
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
