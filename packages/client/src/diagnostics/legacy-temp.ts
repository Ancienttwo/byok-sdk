import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeOwnedPath } from '../daemon/retention/usage';

/** Operator-invoked migration only. Remove this scanner in the next minor release. */
const LEGACY_NAME = /^(?:byok-mcp-|byok-pi-mcp-|byok-pi-prepared-|byok-journal-inspect-|byok-device-credential-)[A-Za-z0-9]{6}$/u;
export interface LegacyTempReport { readonly found: number; readonly deleted: number; readonly bytesReclaimed: number; readonly failures: number; readonly truncated: boolean }
export async function collectLegacyTemp(input: { fix?: boolean; root?: string; now?: Date } = {}): Promise<LegacyTempReport> {
  const root = await fs.realpath(input.root ?? tmpdir());
  let found = 0, deleted = 0, bytesReclaimed = 0, failures = 0, scanned = 0, truncated = false;
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    if (++scanned > 4096) { truncated = true; break; }
    if (!entry.isDirectory() || !LEGACY_NAME.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) continue;
    found++;
    if (input.fix) {
      try { bytesReclaimed += await removeOwnedPath(root, target, input.now ?? new Date()); deleted++; }
      catch { failures++; }
    }
  }
  return { found, deleted, bytesReclaimed, failures, truncated };
}
