import { describe, expect, it, vi } from 'vitest';

import { runCommand, type CommandRunner } from './command-runner';
import { LinuxSecretServiceSecretStore } from './linux-secret-service';
import { ByokKeysError } from './errors';
import {
  DEFAULT_SECRET_SERVICE_PREFIX,
  InMemorySecretStore,
  decodeStrictBase64Utf8,
  modelProviderSecretName,
} from './secret-store';

const CANARY = 'sk-canary-secret-store-0001';
const NUL = String.fromCodePoint(0);

describe('Linux Secret Service', () => {
  const name = 'model-openai-api-key';
  const encoded = `byok-b64-v1:${Buffer.from(CANARY).toString('base64')}`;
  const attrs = ['service', `com.byok.keys.${name}`, 'account', 'local-device'];
  const result = (exitCode = 0, stdout = '', stderr = '') => ({ exitCode, stdout, stderr });
  const store = (commandRunner: CommandRunner) => new LinuxSecretServiceSecretStore({ platform: 'linux', commandRunner });

  it('rejects oversized encoded stdin before spawning, including the storage prefix bytes', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result());
    await expect(store(runner).set(name, 'x'.repeat(6144))).rejects.toMatchObject({ code: 'KEYCHAIN_SECRET_INVALID' });
    const prefixed = new LinuxSecretServiceSecretStore({ platform: 'linux', commandRunner: runner, storagePrefix: 'é'.repeat(4095) });
    await expect(prefixed.set(name, 'x')).rejects.toMatchObject({ code: 'KEYCHAIN_SECRET_INVALID' });
    expect(runner).not.toHaveBeenCalled();
    await store(runner).set(name, 'x'.repeat(6135));
    expect(Buffer.byteLength(runner.mock.calls[0]![2]!)).toBe(8192);
  });

  it.runIf(process.platform !== 'win32')('refuses a signal-killed child as unavailable for lookup, clear and availability', async () => {
    const subject = store(() => runCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']));
    expect(await Promise.allSettled([subject.get(name), subject.delete(name), subject.available()])).toMatchObject([
      { status: 'rejected', reason: { code: 'KEYCHAIN_UNAVAILABLE' } },
      { status: 'rejected', reason: { code: 'KEYCHAIN_UNAVAILABLE' } },
      { status: 'fulfilled', value: false },
    ]);
  });

  it('stores the encoded secret only on stdin, including scoped addresses', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result());
    await store(runner).scope('acct_00000000').set(name, CANARY);
    expect(runner).toHaveBeenCalledWith('secret-tool', [
      'store', `--label=com.byok.keys.scope.acct_00000000.${name}`,
      'service', `com.byok.keys.scope.acct_00000000.${name}`, 'account', 'local-device',
    ], encoded);
    expect(JSON.stringify(runner.mock.calls[0]?.slice(0, 2))).not.toContain(CANARY);
    expect(JSON.stringify(runner.mock.calls[0]?.slice(0, 2))).not.toContain(encoded);
  });

  it('looks up and decodes a present secret', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result(0, `${encoded}\n`));
    await expect(store(runner).get(name)).resolves.toBe(CANARY);
    expect(runner).toHaveBeenCalledWith('secret-tool', ['lookup', ...attrs], undefined);
  });

  it('clears a present secret', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result());
    await expect(store(runner).delete(name)).resolves.toBe(true);
    expect(runner).toHaveBeenCalledWith('secret-tool', ['clear', ...attrs], undefined);
  });

  it('treats empty exit 1 as absent for lookup and clear, with an available service', async () => {
    const subject = store(vi.fn<CommandRunner>().mockResolvedValue(result(1)));
    await expect(subject.get(name)).resolves.toBeUndefined();
    await expect(subject.has(name)).resolves.toBe(false);
    await expect(subject.delete(name)).resolves.toBe(false);
    await expect(subject.available()).resolves.toBe(true);
  });

  it.each([result(127), result(1, '', CANARY), result(1, CANARY)])(
    'fails closed on unavailable tooling or service without disclosing tool output (%#)', async (failure) => {
      const subject = store(vi.fn<CommandRunner>().mockResolvedValue(failure));
      for (const operation of [subject.get(name), subject.delete(name), subject.set(name, CANARY)]) {
        const error = await operation.catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
        expect(JSON.stringify(error)).not.toContain(CANARY);
        expect(String(error)).not.toContain(CANARY);
      }
      await expect(subject.available()).resolves.toBe(false);
    },
  );

  it('does not accept empty exit 1 from store', async () => {
    await expect(store(vi.fn<CommandRunner>().mockResolvedValue(result(1))).set(name, CANARY))
      .rejects.toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
  });

  it('sanitizes runner failures including trusted resolver failure', async () => {
    const subject = store(async () => { throw new Error(CANARY); });
    const error = await subject.get(name).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain(CANARY);
    await expect(subject.available()).resolves.toBe(false);
  });

  it('refuses other platforms before starting the runner', async () => {
    const runner = vi.fn<CommandRunner>();
    const subject = new LinuxSecretServiceSecretStore({ platform: 'darwin', commandRunner: runner });
    await expect(subject.available()).resolves.toBe(false);
    await expect(subject.get(name)).rejects.toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['unprefixed', 'byok-b64-v1:!!!', 'byok-b64-v1:'])(
    'refuses malformed stored secrets (%s)', async (value) => {
      await expect(store(vi.fn<CommandRunner>().mockResolvedValue(result(0, value))).get(name))
        .rejects.toMatchObject({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' });
    },
  );
});

describe('modelProviderSecretName', () => {
  it('derives the credential-store entry name from the profile ref', () => {
    expect(modelProviderSecretName('anthropic')).toBe('model-anthropic-api-key');
    expect(modelProviderSecretName('openrouter-primary')).toBe(
      'model-openrouter-primary-api-key',
    );
  });

  it('gives two profiles of one provider kind two distinct entries', () => {
    expect(modelProviderSecretName('openrouter-primary')).not.toBe(
      modelProviderSecretName('openrouter-backup'),
    );
  });

  it('produces only names the fail-closed validator accepts', () => {
    for (const ref of ['openai', 'deepseek', 'anthropic', 'custom', 'a', 'x'.repeat(64)]) {
      expect(modelProviderSecretName(ref)).toMatch(/^[a-z0-9][a-z0-9_-]{2,95}$/u);
    }
  });

  it('fails closed on a ref that could address another entry', () => {
    for (const ref of ['../escape', 'Upper', 'with.dot', '', 'x'.repeat(65)]) {
      expect(() => modelProviderSecretName(ref)).toThrowError(
        expect.objectContaining({ code: 'PROVIDER_PROFILE_INVALID' }),
      );
    }
  });
});

describe('decodeStrictBase64Utf8', () => {
  it('round-trips utf-8 text including multi-byte characters', () => {
    const text = 'sk-live-余额-éà';
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    expect(decodeStrictBase64Utf8(encoded)).toBe(text);
  });

  it('rejects unpadded base64 rather than silently accepting it', () => {
    expect(decodeStrictBase64Utf8('aGk')).toBeUndefined();
  });

  it('rejects non-base64 characters instead of skipping them', () => {
    // Buffer.from is lenient here and would yield "hi"; the strict decoder must not.
    expect(decodeStrictBase64Utf8('a!G@k=')).toBeUndefined();
  });

  it('rejects a payload that is not valid utf-8', () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
    expect(decodeStrictBase64Utf8(invalidUtf8)).toBeUndefined();
  });

  it('rejects non-canonical padding', () => {
    expect(decodeStrictBase64Utf8('aGk==')).toBeUndefined();
  });
});

describe('InMemorySecretStore', () => {
  it('is always available', async () => {
    await expect(new InMemorySecretStore().available()).resolves.toBe(true);
  });

  it('stores and reads a secret', async () => {
    const store = new InMemorySecretStore();
    await store.set('model-openai-api-key', CANARY);
    await expect(store.get('model-openai-api-key')).resolves.toBe(CANARY);
    await expect(store.has('model-openai-api-key')).resolves.toBe(true);
  });

  it('reports an absent secret as undefined', async () => {
    const store = new InMemorySecretStore();
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
    await expect(store.has('model-openai-api-key')).resolves.toBe(false);
  });

  it('returns false when deleting an absent secret and true when deleting a present one', async () => {
    const store = new InMemorySecretStore();
    await expect(store.delete('model-openai-api-key')).resolves.toBe(false);
    await store.set('model-openai-api-key', CANARY);
    await expect(store.delete('model-openai-api-key')).resolves.toBe(true);
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
  });

  it('validates the name on every operation, failing closed', async () => {
    const store = new InMemorySecretStore();
    await expect(store.get('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    await expect(store.set('bad name', CANARY)).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    await expect(store.delete('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
  });

  it.each([
    ['empty', ''],
    ['newline', `sk-a\nb`],
    ['carriage return', `sk-a\rb`],
    ['null byte', `sk-a${NUL}b`],
  ])('rejects a %s secret value', async (_label, secret) => {
    const store = new InMemorySecretStore();
    await expect(store.set('model-openai-api-key', secret)).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_VALUE_INVALID' }),
    );
  });

  it('throws a ByokKeysError for an invalid value', async () => {
    const store = new InMemorySecretStore();
    let thrown: unknown;
    try {
      await store.set('model-openai-api-key', '');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
  });

  it('isolates a scoped view from the unscoped store', async () => {
    const store = new InMemorySecretStore();
    const scoped = store.scope('acct_00000000');
    await store.set('model-openai-api-key', 'unscoped');
    await scoped.set('model-openai-api-key', 'scoped');
    await expect(store.get('model-openai-api-key')).resolves.toBe('unscoped');
    await expect(scoped.get('model-openai-api-key')).resolves.toBe('scoped');
  });

  it('isolates two sibling scopes from each other', async () => {
    const store = new InMemorySecretStore();
    const left = store.scope('acct_11111111');
    const right = store.scope('acct_22222222');
    await left.set('model-openai-api-key', 'left');
    await right.set('model-openai-api-key', 'right');
    await expect(left.get('model-openai-api-key')).resolves.toBe('left');
    await expect(right.get('model-openai-api-key')).resolves.toBe('right');
    await expect(left.delete('model-openai-api-key')).resolves.toBe(true);
    await expect(right.get('model-openai-api-key')).resolves.toBe('right');
  });

  it('nests scopes', async () => {
    const store = new InMemorySecretStore();
    const nested = store.scope('acct_00000000').scope('workspace0');
    await nested.set('model-openai-api-key', 'nested');
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
    await expect(nested.get('model-openai-api-key')).resolves.toBe('nested');
  });

  it('validates the namespace when scoping, failing closed', () => {
    const store = new InMemorySecretStore();
    expect(() => store.scope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('keys entries by the same service string shape the OS backends use', async () => {
    const entries = new Map<string, string>();
    const store = new InMemorySecretStore({ entries });
    await store.set('model-openai-api-key', CANARY);
    expect([...entries.keys()]).toEqual([
      `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
    ]);
    await store.scope('acct_00000000').set('model-openai-api-key', 'scoped');
    expect([...entries.keys()]).toContain(
      `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.model-openai-api-key`,
    );
  });

  it('labels itself so a caller can tell it apart from an OS backend', () => {
    expect(new InMemorySecretStore().providerLabel).toBe('in-memory');
  });
});
