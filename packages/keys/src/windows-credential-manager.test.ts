import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SECRET_SERVICE_PREFIX } from './secret-store';
import { WindowsCredentialManagerSecretStore } from './windows-credential-manager';

const CANARY = 'sk-canary-windows-0001';
const NUL = String.fromCodePoint(0);
const TARGET = `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`;
const CRED_READ_NOT_FOUND = { win32: 1168 };

interface Response {
  blob?: Buffer;
  hold?: boolean;
  win32?: number;
}
type Callback = (error: unknown, succeeded: number) => void;

interface FakeCall {
  args: unknown[];
  /** The write buffer as the OS would have read it, before it was zeroed. */
  blobAtCall?: string;
  complete(response: Response): void;
  name: string;
}

/**
 * A scripted koffi. The last error exists only for the length of an async
 * callback, as it does on a real worker thread.
 */
class FakeKoffi {
  readonly calls: FakeCall[] = [];
  readonly freed: unknown[] = [];
  #lastError = 0;
  #responses: Response[] = [];

  queue(...responses: Response[]): this {
    this.#responses.push(...responses);
    return this;
  }

  decode(value: { blob: Buffer }, type: unknown): unknown {
    if (type === 'uint8_t') return Uint8Array.from(value.blob);
    return { CredentialBlob: value, CredentialBlobSize: value.blob.length };
  }

  load(): { func(convention: string, name: string): unknown } {
    return { func: (_convention, name) => this.#function(name) };
  }

  out(type: unknown): unknown {
    return type;
  }

  pointer(type: unknown): unknown {
    return type;
  }

  struct(definition: Record<string, unknown>): unknown {
    return definition;
  }

  #function(name: string): unknown {
    if (name === 'GetLastError') return () => this.#lastError;
    if (name === 'CredFree') return (pointer: unknown) => void this.freed.push(pointer);
    return Object.assign(() => undefined, {
      async: (...args: unknown[]) => {
        const callback = args.pop() as Callback;
        const entry = args[0] as { CredentialBlob?: Buffer };
        const call: FakeCall = {
          args,
          blobAtCall: entry.CredentialBlob?.toString('utf8'),
          complete: (response) => {
            const pointer = args[3] as [unknown] | undefined;
            if (response.blob !== undefined && pointer !== undefined) pointer[0] = { blob: response.blob };
            this.#lastError = response.win32 ?? 0;
            callback(null, response.win32 === undefined ? 1 : 0);
            this.#lastError = 0;
          },
          name,
        };
        this.calls.push(call);
        const response = this.#responses.shift();
        if (response === undefined) throw new Error('FakeKoffi: no queued response');
        if (response.hold !== true) queueMicrotask(() => call.complete(response));
      },
    });
  }
}

let koffi: FakeKoffi;

const store = (
  options: ConstructorParameters<
    typeof WindowsCredentialManagerSecretStore
  >[0] = {},
) =>
  new WindowsCredentialManagerSecretStore({
    koffi,
    platform: 'win32',
    ...options,
  });

beforeEach(() => {
  koffi = new FakeKoffi();
});

describe('WindowsCredentialManagerSecretStore.available', () => {
  it('returns false on a non-win32 platform without touching koffi', async () => {
    const load = vi.spyOn(koffi, 'load');
    await expect(store({ platform: 'darwin' }).available()).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('returns true when the credential API binds', async () => {
    await expect(store().available()).resolves.toBe(true);
  });

  it('fails closed when koffi cannot bind the credential API', async () => {
    const unusable = { load: () => { throw new Error('no advapi32'); }, out: () => 0, pointer: () => 0, struct: () => 0 };
    const subject = store({ koffi: unusable });
    await expect(subject.available()).resolves.toBe(false);
    await expect(subject.get('model-openai-api-key')).rejects.toMatchObject({ code: 'CREDENTIAL_MANAGER_UNAVAILABLE' });
  });
});

describe('WindowsCredentialManagerSecretStore.get', () => {
  it('reads the generic credential at the target and frees the OS allocation', async () => {
    koffi.queue({ blob: Buffer.from(CANARY) });
    await expect(store().get('model-openai-api-key')).resolves.toBe(CANARY);
    expect(koffi.calls[0]?.name).toBe('CredReadW');
    expect(koffi.calls[0]?.args.slice(0, 3)).toEqual([TARGET, 1, 0]);
    expect(koffi.freed).toHaveLength(1);
  });

  it('treats ERROR_NOT_FOUND from the callback as an absent secret', async () => {
    koffi.queue(CRED_READ_NOT_FOUND);
    await expect(store().get('model-openai-api-key')).resolves.toBeUndefined();
    expect(koffi.freed).toHaveLength(0);
  });

  it('maps any other Win32 error to CREDENTIAL_MANAGER_READ_FAILED with its code', async () => {
    koffi.queue({ win32: 87 });
    await expect(store().get('model-openai-api-key')).rejects.toMatchObject({
      code: 'CREDENTIAL_MANAGER_READ_FAILED',
      message: expect.stringContaining('win32=87') as string,
    });
  });

  it('round-trips multi-byte utf-8', async () => {
    const secret = 'sk-余额-éà';
    koffi.queue({ blob: Buffer.from(secret) });
    await expect(store().get('model-openai-api-key')).resolves.toBe(secret);
  });

  it.each([
    ['not valid utf-8', Buffer.from([0xff, 0xfe])],
    ['empty', Buffer.alloc(0)],
  ])('fails closed when the blob is %s, and still frees it', async (_label, blob) => {
    koffi.queue({ blob });
    await expect(store().get('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_READ_FAILED' }),
    );
    expect(koffi.freed).toHaveLength(1);
  });
});

describe('WindowsCredentialManagerSecretStore.set', () => {
  it('writes the entry format of every earlier release, then zeroes the buffer', async () => {
    koffi.queue({});
    await store().set('model-openai-api-key', CANARY);
    const call = koffi.calls[0];
    const entry = call?.args[0] as Record<string, unknown> & { CredentialBlob: Buffer };
    expect(call?.name).toBe('CredWriteW');
    expect(call?.args[1]).toBe(0);
    expect(call?.blobAtCall).toBe(CANARY);
    expect(entry).toMatchObject({
      Flags: 0,
      Type: 1,
      TargetName: TARGET,
      Comment: null,
      CredentialBlobSize: Buffer.byteLength(CANARY),
      Persist: 2,
      AttributeCount: 0,
      Attributes: null,
      TargetAlias: null,
      UserName: 'local-device',
    });
    expect(entry.CredentialBlob.every((byte) => byte === 0)).toBe(true);
  });

  it('maps a failed write to CREDENTIAL_MANAGER_WRITE_FAILED', async () => {
    koffi.queue({ win32: 1312 });
    await expect(
      store().set('model-openai-api-key', CANARY),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_MANAGER_WRITE_FAILED',
      message: expect.stringContaining('win32=1312') as string,
    });
  });

  it.each([
    ['empty', ''],
    ['newline', 'sk-a\nb'],
    ['carriage return', 'sk-a\rb'],
    ['null byte', `sk-a${NUL}b`],
    ['over 2560 utf-8 bytes', 'a'.repeat(2_561)],
    ['over 2560 utf-8 bytes via multi-byte characters', '余'.repeat(854)],
  ])('rejects a %s secret before any native call', async (_label, secret) => {
    await expect(
      store().set('model-openai-api-key', secret),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_SECRET_INVALID' }),
    );
    expect(koffi.calls).toHaveLength(0);
  });

  it('accepts a secret of exactly 2560 utf-8 bytes', async () => {
    koffi.queue({});
    await expect(
      store().set('model-openai-api-key', 'a'.repeat(2_560)),
    ).resolves.toBeUndefined();
  });

  it('measures the ceiling in bytes, not characters', async () => {
    koffi.queue({});
    // 853 three-byte characters is 2559 bytes but only 853 characters.
    await expect(
      store().set('model-openai-api-key', '余'.repeat(853)),
    ).resolves.toBeUndefined();
  });
});

describe('WindowsCredentialManagerSecretStore.delete', () => {
  it('deletes and then verifies the entry is gone', async () => {
    koffi.queue({}, CRED_READ_NOT_FOUND);
    await expect(store().delete('model-openai-api-key')).resolves.toBe(true);
    expect(koffi.calls.map((call) => call.name)).toEqual(['CredDeleteW', 'CredReadW']);
    expect(koffi.calls[0]?.args).toEqual([TARGET, 1, 0]);
  });

  it('returns false when the entry was already absent, without verifying', async () => {
    koffi.queue(CRED_READ_NOT_FOUND);
    await expect(store().delete('model-openai-api-key')).resolves.toBe(false);
    expect(koffi.calls).toHaveLength(1);
  });

  it('maps a failed delete to CREDENTIAL_MANAGER_DELETE_FAILED', async () => {
    koffi.queue({ win32: 5 });
    await expect(store().delete('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_DELETE_FAILED' }),
    );
  });

  it('fails closed when the verification read itself fails', async () => {
    koffi.queue({}, { win32: 5 });
    await expect(store().delete('model-openai-api-key')).rejects.toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_MANAGER_DELETE_FAILED' }),
    );
  });

  it('fails closed when the secret survives a reportedly successful delete', async () => {
    koffi.queue({}, { blob: Buffer.from(CANARY) });
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
      expect(koffi.calls).toHaveLength(0);
    },
  );

  it('validates the secret name before any native call', async () => {
    await expect(store().get('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    expect(koffi.calls).toHaveLength(0);
  });

  it('namespaces a scoped store under .scope.<namespace>', async () => {
    koffi.queue(CRED_READ_NOT_FOUND);
    await store().scope('acct_00000000').get('model-openai-api-key');
    expect(koffi.calls[0]?.args[0]).toBe(
      `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.model-openai-api-key`,
    );
  });

  it('rejects an illegal namespace', () => {
    expect(() => store().scope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('carries every option into the scoped store', async () => {
    koffi.queue({});
    await store({ account: 'other-account' })
      .scope('acct_00000000')
      .set('model-openai-api-key', CANARY);
    expect(koffi.calls[0]?.args[0]).toMatchObject({ UserName: 'other-account' });
  });

  it('labels itself as the Windows Credential Manager', () => {
    expect(store().providerLabel).toBe('Windows Credential Manager');
  });
});

describe('WindowsCredentialManagerSecretStore native queue', () => {
  const DEADLINE_MS = 15_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets queued work reach koffi without advancing any deadline. */
  const settled = () => vi.advanceTimersByTimeAsync(0);

  it('reports a read that never returns at the deadline, and frees it when it returns late', async () => {
    koffi.queue({ hold: true });
    const read = store().get('model-openai-api-key');
    const outcome = expect(read).rejects.toMatchObject({
      code: 'CREDENTIAL_MANAGER_READ_FAILED',
      message: expect.stringContaining('deadline') as string,
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await outcome;
    expect(koffi.freed).toHaveLength(0);
    koffi.calls[0]?.complete({ blob: Buffer.from(CANARY) });
    expect(koffi.freed).toHaveLength(1);
  });

  it('zeroes the write buffer when the write returns after its deadline', async () => {
    koffi.queue({ hold: true });
    const write = store().set('model-openai-api-key', CANARY);
    const outcome = expect(write).rejects.toMatchObject({ code: 'CREDENTIAL_MANAGER_WRITE_FAILED' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await outcome;
    const entry = koffi.calls[0]?.args[0] as { CredentialBlob: Buffer };
    expect(entry.CredentialBlob.toString('utf8')).toBe(CANARY);
    koffi.calls[0]?.complete({});
    expect(entry.CredentialBlob.every((byte) => byte === 0)).toBe(true);
  });

  it('keeps a newer write behind a late older one across stores, in arrival order', async () => {
    koffi.queue({ hold: true }, {}, {});
    const older = expect(store().set('model-openai-api-key', 'sk-older')).rejects.toMatchObject({
      code: 'CREDENTIAL_MANAGER_WRITE_FAILED',
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await older;
    const second = store().set('model-openai-api-key', 'sk-second');
    const third = store({ account: 'other-account' }).scope('acct_00000000').set('model-openai-api-key', 'sk-third');
    await settled();
    expect(koffi.calls).toHaveLength(1);
    koffi.calls[0]?.complete({});
    await Promise.all([second, third]);
    expect(koffi.calls.map((call) => call.blobAtCall)).toEqual(['sk-older', 'sk-second', 'sk-third']);
  });

  it('counts the wait toward the deadline, and an expired call never reaches the OS', async () => {
    koffi.queue({ hold: true }, {});
    const stuck = expect(store().set('model-openai-api-key', 'sk-stuck')).rejects.toMatchObject({
      code: 'CREDENTIAL_MANAGER_WRITE_FAILED',
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1_000);
    const waiting = expect(store().set('model-openai-api-key', 'sk-waiting')).rejects.toMatchObject({
      message: expect.stringContaining('deadline') as string,
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await Promise.all([stuck, waiting]);
    koffi.calls[0]?.complete({});
    await settled();
    expect(koffi.calls).toHaveLength(1);
    await store().set('model-openai-api-key', 'sk-next');
    expect(koffi.calls[1]?.blobAtCall).toBe('sk-next');
  });
});
