import type { DeviceCredentialBackend, DeviceRecord, FirstPairingAttempt } from '../../packages/client/src/daemon/device-credential-store';
export class InMemoryDeviceCredentialStore implements DeviceCredentialBackend {
  read(): Promise<DeviceRecord | undefined>;
  readFirstPairingAttempt(): Promise<FirstPairingAttempt | undefined>;
  saveFirstPairingAttempt(attempt: FirstPairingAttempt): Promise<void>;
  replace(record: DeviceRecord): Promise<void>;
  clear(): Promise<boolean>;
}
