import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DeviceRecord {
  deviceId: string;
  deviceToken: string;
}

/**
 * Persists the device identity (deviceId + deviceToken) issued by `pair()`.
 * This is the ONLY credential the daemon itself ever holds — never a
 * runtime's own credentials (see the credential-isolation rule on
 * `RuntimeAdapter`). Stored 0600 under `storeDir` (default `~/.byok/<productId>/`).
 */
export class DeviceStore {
  private readonly filePath: string;

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'device.json');
  }

  static defaultDir(productId: string): string {
    return path.join(os.homedir(), '.byok', productId);
  }

  async load(): Promise<DeviceRecord | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<DeviceRecord>;
    if (typeof parsed.deviceId === 'string' && typeof parsed.deviceToken === 'string') {
      return { deviceId: parsed.deviceId, deviceToken: parsed.deviceToken };
    }
    return undefined;
  }

  async save(record: DeviceRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
    // `mode` on writeFile only applies when the file is created; force it in
    // case a previous, differently-permissioned file already existed.
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
