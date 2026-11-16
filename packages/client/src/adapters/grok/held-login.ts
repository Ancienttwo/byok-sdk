import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The directory Grok's SDK-owned home is built in, inside an execution's `sdk` directory. */
export const GROK_HOME_DIRECTORY = 'grok-home';
/**
 * The login held in an execution directory: its path while it is a regular
 * file, else `undefined`. `sdk/grok-home/auth.json` is the one path where a
 * credential can appear in the scratch: Grok's SDK-owned home links the
 * user's `auth.json`, so a regular file there is a login Grok wrote over the
 * link, possibly the only copy of a refreshed credential; a link or a
 * directory holds none. The release, both execution retention sweeps and
 * every Grok start check it by `lstat` only.
 */
export async function heldLogin(executionDirectory: string): Promise<string | undefined> {
  const file = path.join(executionDirectory, 'sdk', GROK_HOME_DIRECTORY, 'auth.json');
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return stat?.isFile() === true ? file : undefined;
}

/** Every login held in the executions of the scratch root that holds `sdkDir`. */
export async function heldLogins(sdkDir: string): Promise<string[]> {
  const execRoot = path.dirname(path.dirname(sdkDir));
  const held: string[] = [];
  for (const entry of await fs.readdir(execRoot, { withFileTypes: true })) {
    const file = entry.isDirectory() ? await heldLogin(path.join(execRoot, entry.name)) : undefined;
    if (file !== undefined) held.push(file);
  }
  return held;
}

/** What a Host or user does with a held login; the SDK never moves, restores or deletes it. */
export const HELD_LOGIN_RESOLUTION = 'once you confirm which login to keep, move it back to the user GROK_HOME auth.json (~/.grok/auth.json by default) yourself or delete it, then log in to Grok again';
