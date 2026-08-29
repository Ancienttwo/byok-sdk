/**
 * Best-effort physical-machine identity for `POST /byok/pair`.
 *
 * The problem this solves is one physical machine accumulating a new active
 * device row on every re-pair (a reinstall, a wiped credential store, a fresh
 * checkout). The server can only collapse those rows if the client tells it
 * "this is the same machine as before" — and the ONLY safe way to say that is
 * a value that carries no tenant, no product claim, and nothing an operator
 * could correlate back to the raw hardware id.
 *
 * So this module reads one OS-provided machine identifier and returns
 * `sha256(productId + "\n" + rawId)` as lowercase hex. The raw identifier
 * never leaves the process: the digest is domain-separated by the product id,
 * so the same machine paired against two products produces two unrelated
 * values and neither is a stable cross-product device fingerprint.
 *
 * It is deliberately best-effort and NEVER throws. `machineId` is an optional
 * wire field: a machine that cannot be identified (an unsupported platform, a
 * container without `/etc/machine-id`, a locked-down registry) pairs exactly
 * as it does today, gaining a second active row rather than failing to pair.
 * Fail-closed here would mean refusing to enroll a working device over an
 * optimization, which is the wrong trade — but note the failure is silent by
 * construction, so this value is never an authorization input on either side.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { DeviceCommandRunner } from './device-credential-store';
import { runDeviceCommand } from './device-credential-store';

export interface ResolveMachineIdOptions {
  /** Domain separator for the digest — the same machine yields a different value per product. */
  readonly productId: string;
  readonly platform?: NodeJS.Platform;
  /** Injectable process runner, same shape as the credential store's. Tests substitute a double; production gets `runDeviceCommand`. */
  readonly run?: DeviceCommandRunner;
  /** Injectable file read for the Linux probe, for the same reason `run` is injectable. */
  readonly readFile?: (path: string) => Promise<string>;
  /**
   * Upper bound on the whole probe, in milliseconds (default 2000). A probe
   * that never settles — a wedged `ioreg`, a hung registry read, an NFS-backed
   * `/etc/machine-id` — must not stall pairing, because `AuthManager` awaits
   * this value inline before `POST /byok/pair`. On expiry the resolution is
   * `undefined`, the same as every other failure shape.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/** macOS: `ioreg` prints the identifier as one quoted property line. */
const DARWIN_UUID_RE = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u;
/** Windows: `reg query` prints `    MachineGuid    REG_SZ    <value>`. */
const WIN32_GUID_RE = /MachineGuid\s+REG_SZ\s+(\S+)/u;

const LINUX_MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;

async function probeDarwin(run: DeviceCommandRunner): Promise<string | undefined> {
  const result = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  if (result.exitCode !== 0) return undefined;
  return DARWIN_UUID_RE.exec(result.stdout)?.[1];
}

async function probeLinux(readFile: (path: string) => Promise<string>): Promise<string | undefined> {
  for (const path of LINUX_MACHINE_ID_PATHS) {
    try {
      const contents = (await readFile(path)).trim();
      if (contents.length > 0) return contents;
    } catch {
      // Try the next known location; an unreadable path is not an error here.
    }
  }
  return undefined;
}

async function probeWin32(run: DeviceCommandRunner): Promise<string | undefined> {
  const result = await run('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ]);
  if (result.exitCode !== 0) return undefined;
  return WIN32_GUID_RE.exec(result.stdout)?.[1];
}

/**
 * Resolve `probe`, or `undefined` once `timeoutMs` elapses — whichever happens
 * first. The timer is `unref`'d where the runtime supports it, so a probe that
 * never settles cannot keep the process alive past its own work. `race` keeps
 * a handler attached to `probe`, so a rejection that arrives after the timeout
 * already won is still handled rather than becoming an unhandled rejection.
 */
async function withTimeout(
  probe: Promise<string | undefined>,
  timeoutMs: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });

  try {
    return await Promise.race([probe, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The lowercase-hex digest for this machine, or `undefined` when no OS
 * identifier is available. Never throws: every probe failure, every
 * unsupported platform, every empty read, and a probe that exceeds
 * `timeoutMs` all collapse to the same `undefined`.
 */
export async function resolveMachineId(options: ResolveMachineIdOptions): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runDeviceCommand;
  const readFile = options.readFile ?? ((path: string) => fs.readFile(path, 'utf8'));

  let probe: Promise<string | undefined> | undefined;
  if (platform === 'darwin') probe = probeDarwin(run);
  else if (platform === 'linux') probe = probeLinux(readFile);
  else if (platform === 'win32') probe = probeWin32(run);
  if (probe === undefined) return undefined;

  let raw: string | undefined;
  try {
    raw = await withTimeout(probe, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch {
    return undefined;
  }

  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  return createHash('sha256').update(`${options.productId}\n${trimmed}`, 'utf8').digest('hex');
}
