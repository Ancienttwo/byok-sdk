/**
 * `resolveMachineId` — the client half of "one physical machine, one active
 * device row".
 *
 * Two properties matter and both are asserted directly rather than inferred:
 * the raw OS identifier never appears in the result (only a product-salted
 * digest does), and EVERY failure shape collapses to `undefined` instead of
 * throwing. The second is the one worth a test per platform: this value is
 * optional on the wire, so a probe that throws would turn a cosmetic
 * optimization into a device that cannot pair at all.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DeviceCommandResult, DeviceCommandRunner } from '../daemon/device-credential-store';
import { resolveMachineId } from '../daemon/machine-id';

const PRODUCT_ID = 'test-product';

function runner(
  handler: (executable: string, args: readonly string[]) => DeviceCommandResult,
): { run: DeviceCommandRunner; calls: Array<{ executable: string; args: readonly string[] }> } {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (executable, args) => {
      calls.push({ executable, args });
      return handler(executable, args);
    },
  };
}

const ok = (stdout: string): DeviceCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const failed = (): DeviceCommandResult => ({ exitCode: 1, stdout: '', stderr: 'nope' });

/** The independent expectation — recomputed here rather than copied from the implementation. */
function expectedDigest(productId: string, raw: string): string {
  return createHash('sha256').update(`${productId}\n${raw}`, 'utf8').digest('hex');
}

const IOREG_OUTPUT = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 39>
  +-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000205, registered>
      {
        "IOPlatformSerialNumber" = "C02XYZ123456"
        "IOPlatformUUID" = "6A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"
        "board-id" = <"Mac-1234567890ABCDEF">
      }
`;

const REG_OUTPUT = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    9f1d5c2a-3b4e-4f60-8172-93a4b5c6d7e8\r\n\r\n`;

describe('resolveMachineId — platform probes', () => {
  it('parses the macOS IOPlatformUUID out of ioreg output', async () => {
    const { run, calls } = runner(() => ok(IOREG_OUTPUT));

    const resolved = await resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run });

    expect(calls).toEqual([{ executable: 'ioreg', args: ['-rd1', '-c', 'IOPlatformExpertDevice'] }]);
    expect(resolved).toBe(expectedDigest(PRODUCT_ID, '6A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9'));
    // The raw identifier is hashed, never forwarded.
    expect(resolved).not.toContain('6A1B2C3D');
  });

  it('reads the Linux machine-id file, falling back to the dbus copy', async () => {
    const seen: string[] = [];
    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'linux',
      readFile: async (path) => {
        seen.push(path);
        if (path === '/etc/machine-id') throw new Error('ENOENT');
        return 'd3adb33fd3adb33fd3adb33fd3adb33f\n';
      },
    });

    expect(seen).toEqual(['/etc/machine-id', '/var/lib/dbus/machine-id']);
    expect(resolved).toBe(expectedDigest(PRODUCT_ID, 'd3adb33fd3adb33fd3adb33fd3adb33f'));
  });

  it('prefers /etc/machine-id and never reads the fallback when it succeeds', async () => {
    const seen: string[] = [];
    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'linux',
      readFile: async (path) => {
        seen.push(path);
        return 'aaaabbbbccccdddd\n';
      },
    });

    expect(seen).toEqual(['/etc/machine-id']);
    expect(resolved).toBe(expectedDigest(PRODUCT_ID, 'aaaabbbbccccdddd'));
  });

  it('parses the Windows MachineGuid out of reg query output', async () => {
    const { run, calls } = runner(() => ok(REG_OUTPUT));

    const resolved = await resolveMachineId({ productId: PRODUCT_ID, platform: 'win32', run });

    expect(calls).toEqual([
      { executable: 'reg', args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'] },
    ]);
    expect(resolved).toBe(expectedDigest(PRODUCT_ID, '9f1d5c2a-3b4e-4f60-8172-93a4b5c6d7e8'));
  });
});

describe('resolveMachineId — every failure is `undefined`, never a throw', () => {
  it('returns undefined when the macOS probe exits non-zero', async () => {
    const { run } = runner(() => failed());
    expect(await resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run })).toBeUndefined();
  });

  it('returns undefined when ioreg succeeds but prints no IOPlatformUUID', async () => {
    const { run } = runner(() => ok('+-o Root  <class IORegistryEntry>\n'));
    expect(await resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run })).toBeUndefined();
  });

  it('returns undefined when neither Linux machine-id path is readable', async () => {
    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'linux',
      readFile: async () => {
        throw new Error('EACCES');
      },
    });
    expect(resolved).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only Linux machine-id', async () => {
    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'linux',
      readFile: async () => '  \n',
    });
    expect(resolved).toBeUndefined();
  });

  it('returns undefined when the Windows registry query fails or prints no value', async () => {
    const { run: failing } = runner(() => failed());
    expect(await resolveMachineId({ productId: PRODUCT_ID, platform: 'win32', run: failing })).toBeUndefined();

    const { run: empty } = runner(() => ok('ERROR: The system was unable to find the specified registry key.\r\n'));
    expect(await resolveMachineId({ productId: PRODUCT_ID, platform: 'win32', run: empty })).toBeUndefined();
  });

  it('returns undefined on an unsupported platform without running anything', async () => {
    const { run, calls } = runner(() => ok(IOREG_OUTPUT));
    expect(await resolveMachineId({ productId: PRODUCT_ID, platform: 'freebsd', run })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('returns undefined rather than propagating a runner that rejects', async () => {
    const run: DeviceCommandRunner = async () => {
      throw new Error('spawn exploded');
    };
    await expect(resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run })).resolves.toBeUndefined();
  });
});

describe('resolveMachineId — the probe is bounded', () => {
  it('resolves undefined within the timeout when the runner never settles', async () => {
    const started = Date.now();
    const run: DeviceCommandRunner = () => new Promise<DeviceCommandResult>(() => {});

    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'darwin',
      run,
      timeoutMs: 25,
    });

    // `AuthManager.pair` awaits this inline before `POST /byok/pair`, so a
    // wedged probe must not stall pairing: it degrades to the documented
    // "no supersession" case instead of holding the pair request open.
    expect(resolved).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not cut short a probe that settles inside the timeout', async () => {
    const run: DeviceCommandRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok(IOREG_OUTPUT);
    };

    const resolved = await resolveMachineId({
      productId: PRODUCT_ID,
      platform: 'darwin',
      run,
      timeoutMs: 1000,
    });

    expect(resolved).toBe(expectedDigest(PRODUCT_ID, '6A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9'));
  });
});

describe('resolveMachineId — digest shape', () => {
  it('is deterministic, lowercase 64-hex, and matches the wire schema', async () => {
    const { run } = runner(() => ok(IOREG_OUTPUT));
    const first = await resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run });
    const second = await resolveMachineId({ productId: PRODUCT_ID, platform: 'darwin', run });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is salted by the product id — the same machine yields unrelated values per product', async () => {
    const { run } = runner(() => ok(IOREG_OUTPUT));
    const a = await resolveMachineId({ productId: 'product-a', platform: 'darwin', run });
    const b = await resolveMachineId({ productId: 'product-b', platform: 'darwin', run });

    expect(a).not.toBe(b);
    expect(a).toBe(expectedDigest('product-a', '6A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9'));
  });
});
