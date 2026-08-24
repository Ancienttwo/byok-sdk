import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DeviceCredentialStore,
  type DeviceCommandRunner,
  type DeviceCommandResult,
} from '../daemon/device-credential-store';

const nativeWindowsSmoke =
  process.platform === 'win32' && process.env.BYOK_NATIVE_WINDOWS_CREDENTIAL_SMOKE === '1';

const COMMAND_TIMEOUT_MS = 20_000;
const PHASE_TIMEOUT_MS = 25_000;
const CLEAR_PHASE_TIMEOUT_MS = 65_000;
const TEST_TIMEOUT_MS = 180_000;

type NativePhase =
  | 'initial_read'
  | 'replace'
  | 'fresh_read'
  | 'clear'
  | 'final_read'
  | 'cleanup_clear';

let activePhase: NativePhase | undefined;

/**
 * Windows-only diagnostic runner for this opt-in native probe. It executes the
 * exact static production bridge argv/stdin, but owns a hard child-process
 * deadline so a stuck PowerShell process cannot hide which bounded phase hung.
 * stdout/stderr are returned to the production parser and never logged here.
 */
const runBoundedNativeCommand: DeviceCommandRunner = (executable, args, stdin) =>
  new Promise<DeviceCommandResult>((resolve, reject) => {
    const phase = activePhase;
    if (phase === undefined) {
      reject(new Error('Windows credential native command started outside a bounded phase'));
      return;
    }

    const child = spawn(executable, [...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: DeviceCommandResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `Windows credential native command timed out (phase=${phase}, timeout_ms=${COMMAND_TIMEOUT_MS})`,
        ),
      );
    }, COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', () => finish({ exitCode: 127, stdout: '', stderr: '' }));
    child.once('close', (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });

async function runPhase<T>(
  phase: NativePhase,
  operation: () => Promise<T>,
  timeoutMs = PHASE_TIMEOUT_MS,
): Promise<T> {
  if (activePhase !== undefined) {
    throw new Error(`Windows credential native phases overlapped (phase=${phase})`);
  }

  activePhase = phase;
  const startedAt = performance.now();
  console.info(`windows-credential-native phase=${phase} state=start`);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Windows credential native phase timed out (phase=${phase}, timeout_ms=${timeoutMs})`)),
          timeoutMs,
        );
      }),
    ]);
    console.info(
      `windows-credential-native phase=${phase} state=pass duration_ms=${Math.ceil(performance.now() - startedAt)}`,
    );
    return result;
  } catch (error) {
    console.error(
      `windows-credential-native phase=${phase} state=fail duration_ms=${Math.ceil(performance.now() - startedAt)}`,
    );
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    activePhase = undefined;
  }
}

const record = {
  deviceId: 'device-native-windows-ci',
  tenantId: 'tenant-native-windows-ci',
  devicePublicKey: 'fixture-public-key',
  accessToken: 'fixture-access-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  devicePrivateKeyPem: 'fixture-private-key',
} as const;

describe.skipIf(!nativeWindowsSmoke)('Windows Credential Manager native smoke', () => {
  it('round-trips a unique enrollment through fresh provider processes', async () => {
    const productId = `windows-credential-native-ci-${process.pid}-${Date.now()}`;
    const writer = new DeviceCredentialStore({ productId, commandRunner: runBoundedNativeCommand });
    let mayExist = false;

    try {
      expect(await runPhase('initial_read', () => writer.read())).toBeUndefined();

      mayExist = true;
      await runPhase('replace', () => writer.replace(record));

      const reader = new DeviceCredentialStore({ productId, commandRunner: runBoundedNativeCommand });
      expect(await runPhase('fresh_read', () => reader.read())).toEqual(record);
      expect(await runPhase('clear', () => reader.clear(), CLEAR_PHASE_TIMEOUT_MS)).toBe(true);
      mayExist = false;

      const verifier = new DeviceCredentialStore({ productId, commandRunner: runBoundedNativeCommand });
      expect(await runPhase('final_read', () => verifier.read())).toBeUndefined();
    } finally {
      if (mayExist) {
        await runPhase('cleanup_clear', () => writer.clear(), CLEAR_PHASE_TIMEOUT_MS).catch(() => {});
      }
    }
  }, TEST_TIMEOUT_MS);
});
