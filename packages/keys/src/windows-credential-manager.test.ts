import { beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult } from './command-runner';
import { DEFAULT_SECRET_SERVICE_PREFIX } from './secret-store';
import { WindowsCredentialManagerSecretStore } from './windows-credential-manager';

const CANARY = 'sk-canary-windows-0001';
const NUL = String.fromCodePoint(0);

interface Invocation {
  args: string[];
  executable: string;
  stdin: string | undefined;
}

class FakeCommandRunner {
  readonly invocations: Invocation[] = [];
  #results: CommandResult[] = [];

  queue(...results: Partial<CommandResult>[]): this {
    for (const result of results) {
      this.#results.push({ exitCode: 0, stderr: '', stdout: '', ...result });
    }
    return this;
  }

  readonly run = async (
    executable: string,
    args: string[],
    stdin?: string,
  ): Promise<CommandResult> => {
    this.invocations.push({ args, executable, stdin });
    const result = this.#results.shift();
    if (!result) throw new Error('FakeCommandRunner: no queued result');
    return result;
  };
}

const base64 = (secret: string) =>
  Buffer.from(secret, 'utf8').toString('base64');

const request = (invocation: Invocation | undefined) =>
  JSON.parse(invocation?.stdin ?? '{}') as Record<string, unknown>;

let runner: FakeCommandRunner;

const store = (
  options: ConstructorParameters<
    typeof WindowsCredentialManagerSecretStore
  >[0] = {},
) =>
  new WindowsCredentialManagerSecretStore({
    commandRunner: runner.run,
    platform: 'win32',
    ...options,
  });

beforeEach(() => {
  runner = new FakeCommandRunner();
});

describe('WindowsCredentialManagerSecretStore.available', () => {
  it('returns false on a non-win32 platform without spawning anything', async () => {
    await expect(store({ platform: 'darwin' }).available()).resolves.toBe(false);
    expect(runner.invocations).toHaveLength(0);
  });

  it('probes the PowerShell version on win32', async () => {
    runner.queue({ exitCode: 0 });
    await expect(store().available()).resolves.toBe(true);
    expect(runner.invocations[0]).toEqual({
      executable: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.Major',
      ],
      stdin: undefined,
    });
  });

  it('returns false when the probe fails', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().available()).resolves.toBe(false);
  });
});

describe('WindowsCredentialManagerSecretStore.get', () => {
  it('invokes the encoded script and passes the request on stdin', async () => {
    runner.queue({ exitCode: 0, stdout: base64(CANARY) });
    await expect(store().get('model-openai-api-key')).resolves.toBe(CANARY);
    const invocation = runner.invocations[0];
    expect(invocation?.executable).toBe('powershell.exe');
    expect(invocation?.args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    expect(invocation?.args).toHaveLength(5);
    expect(request(invocation)).toEqual({
      operation: 'get',
      target: `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
      username: 'local-device',
    });
  });

  it('ships a UTF-16LE base64 script that declares the Byok credential namespace', () => {
    runner.queue({ exitCode: 44 });
    void store().get('model-openai-api-key');
    const script = Buffer.from(
      runner.invocations[0]?.args[4] ?? '',
      'base64',
    ).toString('utf16le');
    expect(script).toContain('namespace Byok');
    expect(script).toContain('[Byok.CredentialManager]::Read');
    expect(script).not.toMatch(/aiphabee/iu);
  });

  it('treats exit code 44 as an absent secret', async () => {
    runner.queue({ exitCode: 44 });
    await expect(store().get('model-openai-api-key')).resolves.toBeUndefined();
  });

  it('maps any other non-zero exit to CREDENTIAL_MANAGER_READ_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_READ_FAILED' }),
    );
  });

  it('round-trips multi-byte utf-8', async () => {
    const secret = 'sk-余额-éà';
    runner.queue({ exitCode: 0, stdout: `${base64(secret)}\n` });
    await expect(store().get('model-openai-api-key')).resolves.toBe(secret);
  });

  it('fails closed when the script returns a non-base64 payload', async () => {
    runner.queue({ exitCode: 0, stdout: 'not!base64!' });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_READ_FAILED' }),
    );
  });

  it('fails closed when the payload is not valid utf-8', async () => {
    runner.queue({
      exitCode: 0,
      stdout: Buffer.from([0xff, 0xfe]).toString('base64'),
    });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_READ_FAILED' }),
    );
  });

  it('fails closed when the payload decodes to an empty secret', async () => {
    runner.queue({ exitCode: 0, stdout: '' });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_READ_FAILED' }),
    );
  });
});

describe('WindowsCredentialManagerSecretStore.set', () => {
  it('sends the secret base64-encoded on stdin, never in argv', async () => {
    runner.queue({ exitCode: 0 });
    await store().set('model-openai-api-key', CANARY);
    const invocation = runner.invocations[0];
    expect(JSON.stringify(invocation?.args)).not.toContain(CANARY);
    expect(invocation?.stdin).not.toContain(CANARY);
    expect(request(invocation)).toEqual({
      operation: 'set',
      secret_base64: base64(CANARY),
      target: `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
      username: 'local-device',
    });
  });

  it('maps a non-zero exit to CREDENTIAL_MANAGER_WRITE_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(
      store().set('model-openai-api-key', CANARY),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_WRITE_FAILED' }),
    );
  });

  it.each([
    ['empty', ''],
    ['newline', 'sk-a\nb'],
    ['carriage return', 'sk-a\rb'],
    ['null byte', `sk-a${NUL}b`],
    ['over 2560 utf-8 bytes', 'a'.repeat(2_561)],
    ['over 2560 utf-8 bytes via multi-byte characters', '余'.repeat(854)],
  ])('rejects a %s secret before spawning anything', async (_label, secret) => {
    await expect(
      store().set('model-openai-api-key', secret),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_SECRET_INVALID' }),
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it('accepts a secret of exactly 2560 utf-8 bytes', async () => {
    runner.queue({ exitCode: 0 });
    await expect(
      store().set('model-openai-api-key', 'a'.repeat(2_560)),
    ).resolves.toBeUndefined();
  });

  it('measures the ceiling in bytes, not characters', async () => {
    runner.queue({ exitCode: 0 });
    // 853 three-byte characters is 2559 bytes but only 853 characters.
    await expect(
      store().set('model-openai-api-key', '余'.repeat(853)),
    ).resolves.toBeUndefined();
  });
});

describe('WindowsCredentialManagerSecretStore.delete', () => {
  it('deletes and then verifies the entry is gone', async () => {
    runner.queue({ exitCode: 0 }, { exitCode: 44 });
    await expect(store().delete('model-openai-api-key')).resolves.toBe(true);
    expect(runner.invocations).toHaveLength(2);
    expect(request(runner.invocations[0])).toMatchObject({
      operation: 'delete',
    });
    expect(request(runner.invocations[1])).toMatchObject({ operation: 'get' });
  });

  it('returns false when the entry was already absent, without verifying', async () => {
    runner.queue({ exitCode: 44 });
    await expect(store().delete('model-openai-api-key')).resolves.toBe(false);
    expect(runner.invocations).toHaveLength(1);
  });

  it('maps a failed delete to CREDENTIAL_MANAGER_DELETE_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().delete('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_DELETE_FAILED' }),
    );
  });

  it('fails closed when the verification read itself fails', async () => {
    runner.queue({ exitCode: 0 }, { exitCode: 1 });
    await expect(store().delete('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_DELETE_FAILED' }),
    );
  });

  it('fails closed when the secret survives a reportedly successful delete', async () => {
    runner.queue({ exitCode: 0 }, { exitCode: 0, stdout: base64(CANARY) });
    let thrown: unknown;
    try {
      await store().delete('model-openai-api-key');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'CREDENTIAL_MANAGER_DELETE_FAILED',
      message: 'Windows Credential Manager reported deletion but the secret remains',
    });
  });
});

describe('WindowsCredentialManagerSecretStore platform and scope', () => {
  it.each(['get', 'set', 'delete'] as const)(
    'refuses %s on a non-win32 platform, with no plaintext fallback',
    async (operation) => {
      const subject = store({ platform: 'darwin' });
      const call =
        operation === 'set'
          ? subject.set('model-openai-api-key', CANARY)
          : operation === 'get'
            ? subject.get('model-openai-api-key')
            : subject.delete('model-openai-api-key');
      await expect(call).rejects.toThrowError(
        expect.objectContaining({ code: 'CREDENTIAL_MANAGER_UNAVAILABLE' }),
      );
      expect(runner.invocations).toHaveLength(0);
    },
  );

  it('validates the secret name before spawning', async () => {
    await expect(store().get('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it('namespaces a scoped store under .scope.<namespace>', async () => {
    runner.queue({ exitCode: 44 });
    await store().scope('acct_00000000').get('model-openai-api-key');
    expect(request(runner.invocations[0])).toMatchObject({
      target: `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.model-openai-api-key`,
    });
  });

  it('rejects an illegal namespace', () => {
    expect(() => store().scope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('carries every option into the scoped store', async () => {
    runner.queue({ exitCode: 44 });
    await store({ account: 'other-account' })
      .scope('acct_00000000')
      .get('model-openai-api-key');
    expect(request(runner.invocations[0])).toMatchObject({
      username: 'other-account',
    });
  });

  it('labels itself as the Windows Credential Manager', () => {
    expect(store().providerLabel).toBe('Windows Credential Manager');
  });
});
