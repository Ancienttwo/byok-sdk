import { beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult } from './command-runner';
import {
  DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX,
  MacOsKeychainSecretStore,
} from './macos-keychain';
import { DEFAULT_SECRET_SERVICE_PREFIX } from './secret-store';

const CANARY = 'sk-canary-macos-0001';
const NUL = String.fromCodePoint(0);
const KEYCHAIN_PATH = '/private/tmp/byok-login.keychain-db';

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

const encoded = (secret: string) =>
  `${DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX}${Buffer.from(secret, 'utf8').toString('base64')}`;

let runner: FakeCommandRunner;

const store = (
  options: ConstructorParameters<typeof MacOsKeychainSecretStore>[0] = {},
) =>
  new MacOsKeychainSecretStore({
    commandRunner: runner.run,
    platform: 'darwin',
    ...options,
  });

beforeEach(() => {
  runner = new FakeCommandRunner();
});

describe('MacOsKeychainSecretStore.available', () => {
  it('returns false on a non-darwin platform without spawning anything', async () => {
    const subject = store({ platform: 'linux' });
    await expect(subject.available()).resolves.toBe(false);
    expect(runner.invocations).toHaveLength(0);
  });

  it('probes the user default keychain on darwin', async () => {
    runner.queue({ exitCode: 0 });
    await expect(store().available()).resolves.toBe(true);
    expect(runner.invocations[0]).toEqual({
      executable: '/usr/bin/security',
      args: ['default-keychain', '-d', 'user'],
      stdin: undefined,
    });
  });

  it('returns false when the probe fails', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().available()).resolves.toBe(false);
  });

  it('probes the explicitly selected keychain when configured', async () => {
    runner.queue({ exitCode: 0 });
    await expect(
      store({ keychainPath: KEYCHAIN_PATH }).available(),
    ).resolves.toBe(true);
    expect(runner.invocations[0]).toEqual({
      executable: '/usr/bin/security',
      args: ['show-keychain-info', KEYCHAIN_PATH],
      stdin: undefined,
    });
  });

  it.each([
    ['empty', ''],
    ['relative', 'login.keychain-db'],
    ['multiline', `${KEYCHAIN_PATH}\nforged-log`],
  ])('rejects an invalid explicit keychain path (%s)', (_label, keychainPath) => {
    expect(() => store({ keychainPath })).toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_ARGUMENT_INVALID' }),
    );
  });
});

describe('MacOsKeychainSecretStore.get', () => {
  it('reads through find-generic-password with the composed service name', async () => {
    runner.queue({ exitCode: 0, stdout: `${encoded(CANARY)}\n` });
    await expect(store().get('model-openai-api-key')).resolves.toBe(CANARY);
    expect(runner.invocations[0]).toEqual({
      executable: '/usr/bin/security',
      args: [
        'find-generic-password',
        '-a',
        'local-device',
        '-s',
        `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
        '-w',
      ],
      stdin: undefined,
    });
  });

  it('treats exit code 44 as an absent secret', async () => {
    runner.queue({ exitCode: 44 });
    await expect(store().get('model-openai-api-key')).resolves.toBeUndefined();
  });

  it('maps any other non-zero exit to KEYCHAIN_READ_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_READ_FAILED' }),
    );
  });

  it('strips a CRLF terminator before decoding', async () => {
    runner.queue({ exitCode: 0, stdout: `${encoded(CANARY)}\r\n` });
    await expect(store().get('model-openai-api-key')).resolves.toBe(CANARY);
  });

  it('appends the explicitly selected keychain to the read argv', async () => {
    runner.queue({ exitCode: 0, stdout: `${encoded(CANARY)}\n` });
    await expect(
      store({ keychainPath: KEYCHAIN_PATH }).get('model-openai-api-key'),
    ).resolves.toBe(CANARY);
    expect(runner.invocations[0]?.args).toEqual([
      'find-generic-password',
      '-a',
      'local-device',
      '-s',
      `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
      '-w',
      KEYCHAIN_PATH,
    ]);
  });

  it('round-trips multi-byte utf-8 through the storage prefix', async () => {
    const secret = 'sk-余额-éà';
    runner.queue({ exitCode: 0, stdout: `${encoded(secret)}\n` });
    await expect(store().get('model-openai-api-key')).resolves.toBe(secret);
  });

  it('fails closed on an unprefixed stored value by default', async () => {
    runner.queue({ exitCode: 0, stdout: `${CANARY}\n` });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' }),
    );
  });

  it('does not leak the undecodable value in the thrown message', async () => {
    runner.queue({ exitCode: 0, stdout: `${CANARY}\n` });
    let thrown: unknown;
    try {
      await store().get('model-openai-api-key');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).not.toContain(CANARY);
  });

  it('returns an unprefixed value only when allowUnprefixedRead is explicitly true', async () => {
    runner.queue({ exitCode: 0, stdout: `${CANARY}\n` });
    await expect(
      store({ allowUnprefixedRead: true }).get('model-openai-api-key'),
    ).resolves.toBe(CANARY);
  });

  it('still fails closed when allowUnprefixedRead is explicitly false', async () => {
    runner.queue({ exitCode: 0, stdout: `${CANARY}\n` });
    await expect(
      store({ allowUnprefixedRead: false }).get('model-openai-api-key'),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' }),
    );
  });

  it('fails closed on a prefixed value whose payload is not valid base64', async () => {
    runner.queue({
      exitCode: 0,
      stdout: `${DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX}not!base64!\n`,
    });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' }),
    );
  });

  it('fails closed on a prefixed value whose payload is not valid utf-8', async () => {
    const payload = Buffer.from([0xff, 0xfe]).toString('base64');
    runner.queue({
      exitCode: 0,
      stdout: `${DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX}${payload}\n`,
    });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' }),
    );
  });

  it('fails closed on a prefixed value that decodes to an empty secret', async () => {
    runner.queue({
      exitCode: 0,
      stdout: `${DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX}\n`,
    });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' }),
    );
  });

  it('honours an injected storage prefix, which is how K4 stays byte-compatible', async () => {
    const storagePrefix = 'aiphabee-b64-v1:';
    runner.queue({
      exitCode: 0,
      stdout: `${storagePrefix}${Buffer.from(CANARY, 'utf8').toString('base64')}\n`,
    });
    await expect(
      store({ storagePrefix }).get('model-openai-api-key'),
    ).resolves.toBe(CANARY);
  });
});

describe('MacOsKeychainSecretStore.set', () => {
  it('writes through interactive mode so the secret never reaches argv', async () => {
    runner.queue({ exitCode: 0 });
    await store().set('model-openai-api-key', CANARY);
    const invocation = runner.invocations[0];
    expect(invocation?.executable).toBe('/usr/bin/security');
    expect(invocation?.args).toEqual(['-i']);
    expect(JSON.stringify(invocation?.args)).not.toContain(CANARY);
    expect(invocation?.stdin).toBe(
      `add-generic-password -U -a "local-device" -s "${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key" -w "${encoded(CANARY)}"\n`,
    );
  });

  it('stores the base64 form, not the plaintext', async () => {
    runner.queue({ exitCode: 0 });
    await store().set('model-openai-api-key', CANARY);
    expect(runner.invocations[0]?.stdin).not.toContain(CANARY);
  });

  it('appends a safely quoted explicit keychain path in interactive mode', async () => {
    const keychainPath = '/private/tmp/byok-"login"\\keychain-db';
    runner.queue({ exitCode: 0 });
    await store({ keychainPath }).set('model-openai-api-key', CANARY);
    expect(runner.invocations[0]?.stdin).toBe(
      `add-generic-password -U -a "local-device" -s "${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key" -w "${encoded(CANARY)}" "${keychainPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`,
    );
  });

  it('maps a non-zero exit to KEYCHAIN_WRITE_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(
      store().set('model-openai-api-key', CANARY),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_WRITE_FAILED' }),
    );
  });

  it.each([
    ['empty', ''],
    ['newline', 'sk-a\nb'],
    ['carriage return', 'sk-a\rb'],
    ['null byte', `sk-a${NUL}b`],
    ['over 16384 characters', 'a'.repeat(16_385)],
  ])('rejects a %s secret before spawning anything', async (_label, secret) => {
    await expect(
      store().set('model-openai-api-key', secret),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_SECRET_INVALID' }),
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it('accepts a secret of exactly 16384 characters', async () => {
    runner.queue({ exitCode: 0 });
    await expect(
      store().set('model-openai-api-key', 'a'.repeat(16_384)),
    ).resolves.toBeUndefined();
  });

  it('escapes quotes and backslashes in the interactive argument', async () => {
    runner.queue({ exitCode: 0 });
    await store({ account: 'we"ird\\account' }).set(
      'model-openai-api-key',
      CANARY,
    );
    expect(runner.invocations[0]?.stdin).toContain('-a "we\\"ird\\\\account"');
  });

  it('refuses an account carrying a newline rather than quoting it away', async () => {
    await expect(
      store({ account: 'bad\naccount' }).set('model-openai-api-key', CANARY),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_ARGUMENT_INVALID' }),
    );
  });
});

describe('MacOsKeychainSecretStore.delete', () => {
  it('deletes through delete-generic-password', async () => {
    runner.queue({ exitCode: 0 });
    await expect(store().delete('model-openai-api-key')).resolves.toBe(true);
    expect(runner.invocations[0]?.args).toEqual([
      'delete-generic-password',
      '-a',
      'local-device',
      '-s',
      `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
    ]);
  });

  it('appends the explicitly selected keychain to the delete argv', async () => {
    runner.queue({ exitCode: 0 });
    await expect(
      store({ keychainPath: KEYCHAIN_PATH }).delete('model-openai-api-key'),
    ).resolves.toBe(true);
    expect(runner.invocations[0]?.args).toEqual([
      'delete-generic-password',
      '-a',
      'local-device',
      '-s',
      `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
      KEYCHAIN_PATH,
    ]);
  });

  it('returns false when the entry was already absent', async () => {
    runner.queue({ exitCode: 44 });
    await expect(store().delete('model-openai-api-key')).resolves.toBe(false);
  });

  it('maps any other non-zero exit to KEYCHAIN_DELETE_FAILED', async () => {
    runner.queue({ exitCode: 1 });
    await expect(store().delete('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'KEYCHAIN_DELETE_FAILED' }),
    );
  });
});

describe('MacOsKeychainSecretStore platform and scope', () => {
  it.each(['get', 'set', 'delete'] as const)(
    'refuses %s on a non-darwin platform, with no plaintext fallback',
    async (operation) => {
      const subject = store({ platform: 'win32' });
      const call =
        operation === 'set'
          ? subject.set('model-openai-api-key', CANARY)
          : operation === 'get'
            ? subject.get('model-openai-api-key')
            : subject.delete('model-openai-api-key');
      await expect(call).rejects.toThrowError(
        expect.objectContaining({ code: 'KEYCHAIN_UNAVAILABLE' }),
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
    expect(runner.invocations[0]?.args).toContain(
      `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.model-openai-api-key`,
    );
  });

  it('nests scopes', async () => {
    runner.queue({ exitCode: 44 });
    await store()
      .scope('acct_00000000')
      .scope('workspace0')
      .get('model-openai-api-key');
    expect(runner.invocations[0]?.args).toContain(
      `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.scope.workspace0.model-openai-api-key`,
    );
  });

  it('rejects an illegal namespace', () => {
    expect(() => store().scope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('carries every option into the scoped store', async () => {
    runner.queue({ exitCode: 0, stdout: `${CANARY}\n` });
    const scoped = store({
      account: 'other-account',
      allowUnprefixedRead: true,
      keychainPath: KEYCHAIN_PATH,
    }).scope('acct_00000000');
    await expect(scoped.get('model-openai-api-key')).resolves.toBe(CANARY);
    expect(runner.invocations[0]?.args).toContain('other-account');
    expect(runner.invocations[0]?.args).toContain(KEYCHAIN_PATH);
  });

  it('labels itself as the macOS Keychain', () => {
    expect(store().providerLabel).toBe('macOS Keychain');
  });
});
