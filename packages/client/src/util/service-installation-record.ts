// The installation reads a daemon needs before it starts (#2011), below both
// daemon/ and lifecycle/ so the start check does not import the installer.
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { VERSION_ID } from '../service-payload-manifest.js';

export type InstallPointer = 'current' | 'previous';

/** `<storeDir>/service/installation.json`: where this store's installation lives. */
export interface ServiceInstallationRecord {
  format: 'byok-service-installation';
  version: 1;
  installRoot: string;
}

export function serviceInstallationRecordPath(storeDir: string): string {
  return join(storeDir, 'service', 'installation.json');
}

/** The installation record of a store, or `undefined` when the service is not installed from payloads. */
export async function readServiceInstallationRecord(storeDir: string): Promise<ServiceInstallationRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(serviceInstallationRecordPath(storeDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const record = JSON.parse(text) as Partial<ServiceInstallationRecord>;
  if (record.format !== 'byok-service-installation' || record.version !== 1 || typeof record.installRoot !== 'string' || !isAbsolute(record.installRoot)) {
    throw new Error(`service installation record ${serviceInstallationRecordPath(storeDir)} is not a version 1 record`);
  }
  return record as ServiceInstallationRecord;
}

/** The version `<installRoot>/<name>` points at, or `undefined` when the pointer is absent. */
export async function readInstallPointer(installRoot: string, name: InstallPointer): Promise<string | undefined> {
  const link = join(installRoot, name);
  let target: string;
  try {
    target = await fs.readlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const id = basename(target.replace(/[\\/]+$/u, ''));
  if (!VERSION_ID.test(id)) throw new Error(`${link} does not point into ${join(installRoot, 'versions')}`);
  return id;
}

/**
 * @internal Whether a daemon on `storeDir` must not start (#2011): its
 * installation journals a pending operation with `current` absent, so the
 * stores may be mid-restore. The SDK's own entries (`byok-agent start`,
 * createDaemon) check it under the store lease; a process with no
 * installation record is outside this guarantee (the Host's contract). Any
 * receipt version counts: only the state is read.
 */
export async function installationHoldsStart(storeDir: string): Promise<boolean> {
  const record = await readServiceInstallationRecord(storeDir);
  if (record === undefined || (await readInstallPointer(record.installRoot, 'current')) !== undefined) return false;
  const text = await fs.readFile(join(record.installRoot, 'upgrade-receipt.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  return text !== undefined && (JSON.parse(text) as { state?: unknown }).state === 'pending';
}
