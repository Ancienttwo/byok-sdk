import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  computeClientAuth,
  computeServerProof,
  controlEndpointPath,
  controlPipeName,
  controlSocketPath,
  controlTokenPath,
  NdjsonLineReader,
  parseApprovalsRequestParams,
  parseApprovalsResolveParams,
  parseClientAuth,
  parseClientHello,
  parseRawControlRequest,
  parseServerHello,
  parseServerReady,
  parseShutdownParams,
  randomNonceHex,
  timingSafeEqualHex,
} from '../daemon/control-protocol';
import {
  INPUT_PREPARATION_CANCEL_METHOD,
  INPUT_PREPARATION_LOOKUP_METHOD,
  INPUT_PREPARATION_PREPARE_METHOD,
  parseInputPreparationCancelParams,
  parseInputPreparationLookupParams,
  parseInputPreparationRequestParams,
} from '../daemon/control-protocol';
import { INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';

describe('control-protocol: endpoint path derivation', () => {
  it('controlSocketPath uses <storeDir>/control.sock when comfortably short', () => {
    expect(controlSocketPath('/Users/me/.byok/acme')).toBe('/Users/me/.byok/acme/control.sock');
  });

  it('controlSocketPath falls back to a short, deterministic fixed-root path once the natural path would be too long, nested under a private per-daemon subdirectory (not a bare file directly in that shared root)', () => {
    const longStoreDir = `/Users/someone/.byok/${'x'.repeat(200)}`;
    const path1 = controlSocketPath(longStoreDir);
    const path2 = controlSocketPath(longStoreDir);
    expect(path1).toBe(path2); // deterministic — the client must compute the identical fallback independently
    expect(Buffer.byteLength(path1, 'utf8')).toBeLessThanOrEqual(104); // fits macOS's sun_path limit
    expect(path1).not.toContain(longStoreDir);
    expect(path1.startsWith('/')).toBe(true);
    expect(path.basename(path1)).toBe('sock');
    expect(path.basename(path.dirname(path1))).toMatch(/^byok-[0-9a-f]{16}$/); // per-daemon private subdirectory, not a bare file in os.tmpdir()
  });

  it('controlSocketPath fallback differs for different storeDirs', () => {
    const a = controlSocketPath(`/a/${'x'.repeat(200)}`);
    const b = controlSocketPath(`/b/${'x'.repeat(200)}`);
    expect(a).not.toBe(b);
  });

  it('controlPipeName is deterministic for the same productId+storeDir and looks like a Windows pipe', () => {
    const name1 = controlPipeName('acme', '/Users/me/.byok/acme');
    const name2 = controlPipeName('acme', '/Users/me/.byok/acme');
    expect(name1).toBe(name2);
    expect(name1.startsWith('\\\\.\\pipe\\byok-')).toBe(true);
  });

  it('controlPipeName differs across productId or storeDir', () => {
    const base = controlPipeName('acme', '/Users/me/.byok/acme');
    const differentProduct = controlPipeName('other-product', '/Users/me/.byok/acme');
    const differentStore = controlPipeName('acme', '/Users/me/.byok/other');
    expect(differentProduct).not.toBe(base);
    expect(differentStore).not.toBe(base);
  });

  it('controlPipeName does not depend on the OS user — a WinSW service account and the interactive operator CLI must derive the same name for the same productId+storeDir', () => {
    const userInfoSpy = vi.spyOn(os, 'userInfo');
    userInfoSpy.mockReturnValue({ username: 'SYSTEM', uid: 0, gid: 0, shell: null, homedir: '/root' });
    const asServiceAccount = controlPipeName('acme', '/Users/me/.byok/acme');
    userInfoSpy.mockReturnValue({ username: 'alice', uid: 501, gid: 20, shell: '/bin/zsh', homedir: '/Users/alice' });
    const asInteractiveUser = controlPipeName('acme', '/Users/me/.byok/acme');
    userInfoSpy.mockRestore();
    expect(asServiceAccount).toBe(asInteractiveUser);
  });

  it('controlPipeName normalizes storeDir with path.resolve so a trivial path-form difference (e.g. a trailing slash) cannot split the name', () => {
    const withTrailingSlash = controlPipeName('acme', '/Users/me/.byok/acme/');
    const canonical = controlPipeName('acme', '/Users/me/.byok/acme');
    expect(withTrailingSlash).toBe(canonical);
  });

  it('controlEndpointPath dispatches to the pipe name on win32 and the socket path everywhere else', () => {
    const storeDir = '/Users/me/.byok/acme';
    expect(controlEndpointPath('acme', storeDir, 'win32')).toBe(controlPipeName('acme', storeDir));
    expect(controlEndpointPath('acme', storeDir, 'darwin')).toBe(controlSocketPath(storeDir));
    expect(controlEndpointPath('acme', storeDir, 'linux')).toBe(controlSocketPath(storeDir));
  });

  it('controlTokenPath is <storeDir>/control.token', () => {
    expect(controlTokenPath('/Users/me/.byok/acme')).toBe('/Users/me/.byok/acme/control.token');
  });
});

describe('control-protocol: handshake math', () => {
  it('computeServerProof/computeClientAuth are deterministic for the same inputs', () => {
    const token = 'a'.repeat(64);
    const nonce = 'b'.repeat(64);
    expect(computeServerProof(token, nonce)).toBe(computeServerProof(token, nonce));
    expect(computeClientAuth(token, nonce)).toBe(computeClientAuth(token, nonce));
  });

  it('computeServerProof and computeClientAuth never collide for the same token+nonce (distinct HMAC labels)', () => {
    const token = 'a'.repeat(64);
    const nonce = 'b'.repeat(64);
    expect(computeServerProof(token, nonce)).not.toBe(computeClientAuth(token, nonce));
  });

  it('a different token produces a different proof', () => {
    const nonce = 'b'.repeat(64);
    expect(computeServerProof('token-a', nonce)).not.toBe(computeServerProof('token-b', nonce));
  });

  it('randomNonceHex produces 64 hex chars (32 bytes) and is not constant', () => {
    const a = randomNonceHex();
    const b = randomNonceHex();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('timingSafeEqualHex: equal hex strings compare equal, unequal ones do not, and length mismatch is a safe false (not a throw)', () => {
    expect(timingSafeEqualHex('ab12', 'ab12')).toBe(true);
    expect(timingSafeEqualHex('ab12', 'ab13')).toBe(false);
    expect(timingSafeEqualHex('ab12', 'ab1234')).toBe(false);
    expect(() => timingSafeEqualHex('ab12', 'ab1234')).not.toThrow();
  });
});

describe('control-protocol: frame parsers (used by both control-server.ts and control-client.ts)', () => {
  it('parseClientHello accepts a well-formed hello and rejects anything else', () => {
    expect(parseClientHello({ v: 1, hello: 'client', nonce: 'abc' })).toEqual({ v: 1, hello: 'client', nonce: 'abc' });
    expect(parseClientHello({ v: 2, hello: 'client', nonce: 'abc' })).toBeUndefined();
    expect(parseClientHello({ v: 1, hello: 'server', nonce: 'abc' })).toBeUndefined();
    expect(parseClientHello({ v: 1, hello: 'client' })).toBeUndefined();
    expect(parseClientHello('not an object')).toBeUndefined();
    expect(parseClientHello(null)).toBeUndefined();
  });

  it('parseServerHello accepts a well-formed hello and rejects anything else', () => {
    expect(parseServerHello({ v: 1, hello: 'server', proof: 'p', nonce: 'n' })).toEqual({
      v: 1,
      hello: 'server',
      proof: 'p',
      nonce: 'n',
    });
    expect(parseServerHello({ v: 1, hello: 'server', proof: 'p' })).toBeUndefined();
    expect(parseServerHello({ v: 1, hello: 'client', proof: 'p', nonce: 'n' })).toBeUndefined();
  });

  it('parseClientAuth accepts a well-formed auth frame and rejects anything else', () => {
    expect(parseClientAuth({ v: 1, auth: 'x' })).toEqual({ v: 1, auth: 'x' });
    expect(parseClientAuth({ v: 1 })).toBeUndefined();
    expect(parseClientAuth({ v: 1, auth: 5 })).toBeUndefined();
  });

  it('parseServerReady accepts only {v:1, ready:true}', () => {
    expect(parseServerReady({ v: 1, ready: true })).toEqual({ v: 1, ready: true });
    expect(parseServerReady({ v: 1, ready: false })).toBeUndefined();
    expect(parseServerReady({ v: 2, ready: true })).toBeUndefined();
  });

  it('parseRawControlRequest requires string id+method but passes v through unvalidated (server decides bad_version)', () => {
    expect(parseRawControlRequest({ v: 1, id: 'r1', method: 'status' })).toEqual({ v: 1, id: 'r1', method: 'status', params: undefined });
    expect(parseRawControlRequest({ v: 99, id: 'r1', method: 'status' })).toEqual({ v: 99, id: 'r1', method: 'status', params: undefined });
    expect(parseRawControlRequest({ id: 'r1' })).toBeUndefined(); // no method
    expect(parseRawControlRequest({ method: 'status' })).toBeUndefined(); // no id
    expect(parseRawControlRequest('garbage')).toBeUndefined();
  });

  it('parseApprovalsResolveParams validates approvalId + decision, reason optional', () => {
    expect(parseApprovalsResolveParams({ approvalId: 'a1', decision: 'approve' })).toEqual({
      approvalId: 'a1',
      decision: 'approve',
      reason: undefined,
    });
    expect(parseApprovalsResolveParams({ approvalId: 'a1', decision: 'reject', reason: 'no' })).toEqual({
      approvalId: 'a1',
      decision: 'reject',
      reason: 'no',
    });
    expect(parseApprovalsResolveParams({ approvalId: 'a1', decision: 'maybe' })).toBeUndefined();
    expect(parseApprovalsResolveParams({ decision: 'approve' })).toBeUndefined();
    expect(parseApprovalsResolveParams(undefined)).toBeUndefined();
  });

  it('M4 Phase 3: parseApprovalsRequestParams requires a non-empty taskId and a string summary', () => {
    expect(parseApprovalsRequestParams({ taskId: 't1', summary: 'Bash: echo hi' })).toEqual({
      taskId: 't1',
      summary: 'Bash: echo hi',
    });
    expect(parseApprovalsRequestParams({ taskId: 't1', summary: '' })).toEqual({ taskId: 't1', summary: '' });
    expect(parseApprovalsRequestParams({ taskId: '', summary: 'x' })).toBeUndefined(); // empty taskId rejected
    expect(parseApprovalsRequestParams({ summary: 'x' })).toBeUndefined(); // missing taskId
    expect(parseApprovalsRequestParams({ taskId: 't1' })).toBeUndefined(); // missing summary
    expect(parseApprovalsRequestParams({ taskId: 5, summary: 'x' })).toBeUndefined();
    expect(parseApprovalsRequestParams(undefined)).toBeUndefined();
    expect(parseApprovalsRequestParams('garbage')).toBeUndefined();
  });

  it('parseShutdownParams accepts a known reason and defaults everything else to {} rather than throwing', () => {
    expect(parseShutdownParams({ reason: 'unpair' })).toEqual({ reason: 'unpair' });
    expect(parseShutdownParams({ reason: 'operator' })).toEqual({ reason: 'operator' });
    expect(parseShutdownParams({ reason: 'bogus' })).toEqual({});
    expect(parseShutdownParams(undefined)).toEqual({});
    expect(parseShutdownParams({})).toEqual({});
  });
});

describe('control-protocol: NdjsonLineReader', () => {
  it('splits complete lines and holds a trailing partial line until completed', () => {
    const reader = new NdjsonLineReader();
    expect(reader.push(Buffer.from('{"a":1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
  });

  it('handles a line split across a multi-byte UTF-8 character boundary without corrupting it', () => {
    const reader = new NdjsonLineReader();
    const payload = Buffer.from('{"text":"café"}\n', 'utf8'); // é is 2 bytes in UTF-8
    const mid = payload.length - 3; // split inside the 2-byte é sequence
    const first = payload.subarray(0, mid);
    const second = payload.subarray(mid);
    expect(reader.push(first)).toEqual([]);
    expect(reader.push(second)).toEqual(['{"text":"café"}']);
  });

  it('returns no lines when given no newline at all', () => {
    const reader = new NdjsonLineReader();
    expect(reader.push(Buffer.from('partial-no-newline'))).toEqual([]);
  });
});

/**
 * B-P2 local primitive: the three `input_preparation.*` param gates
 * (`docs/researches/runtime-input-preparation-contract.md` §10.3.1).
 *
 * These parsers are the definition of what the daemon accepts, and they are
 * exported for a host building its own caller — so an accidental relaxation
 * here silently widens the public contract, not just the daemon's.
 */
describe('control-protocol: input_preparation param gates', () => {
  const scope = { deviceId: 'device-1', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' };

  function accountingPolicyRef(): Record<string, unknown> {
    return {
      revision: 'accounting-r1',
      ruledRuntime: '@byok-sdk/pi-coding-agent@0.85.1005+d981de1229ef899957bbe968bc8dcda02a21f477.5',
      ruledTarget: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
      ruledResidualKeys: ['max_tokens'],
    };
  }

  function validRequest(): Record<string, unknown> {
    return {
      format: INPUT_PREPARATION_REQUEST_FORMAT,
      version: INPUT_PREPARATION_VERSION,
      requestId: 'prep-1',
      policyRevision: 'limits-rev-1',
      scope: { ...scope },
      source: { revision: 'src-rev-1', digest: 'src-digest-1' },
      selection: {
        model: {
          id: 'glm-4.6',
          name: 'GLM 4.6',
          api: 'openai-completions',
          provider: 'zai',
          baseUrl: 'https://api.z.ai/api/coding/paas/v4',
          reasoning: false,
          input: ['text'],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
        options: { cacheRetention: 'none', maxTokens: 4_096 },
      },
      snapshot: {
        prompt: {
          cwd: '/workspace',
          toolSnippets: {},
          toolGuidelines: {},
          promptGuidelines: [],
          contextFiles: [{ path: 'AGENTS.md', content: 'x' }],
          skills: [],
          docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
        },
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      },
      permissionMode: 'auto',
      requiredToolsets: ['team'],
    };
  }

  it('accepts exactly the one strict request shape and returns a private copy', () => {
    const raw = validRequest();
    const parsed = parseInputPreparationRequestParams(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.request.requestId).toBe('prep-1');
    expect(parsed.request.permissionMode).toBe('auto');
    expect(parsed.request.requiredToolsets).toEqual(['team']);
    // A copy, not the caller's own arrays/objects.
    expect(parsed.request.snapshot.prompt.toolSnippets).not.toBe((raw.snapshot as { prompt: { toolSnippets: unknown } }).prompt.toolSnippets);
    expect(parsed.request.requiredToolsets).not.toBe(raw.requiredToolsets);
  });

  /**
   * The property this contract turns on: a caller cannot state a tool schema
   * and cannot state an executor identity. Both are refused by NAME, as
   * `unsupported_input` rather than `bad_request`, because a caller sending
   * either is not sending a slightly wrong request — it is asserting an
   * authority that now belongs to the device.
   */
  it.each([
    ['a caller-supplied executor map', (r: Record<string, unknown>) => ({ ...r, toolExecutors: { read: 'exec:read@1' } }), 'toolExecutors'],
    [
      'a caller-supplied tool schema',
      (r: Record<string, unknown>) => ({
        ...r,
        snapshot: {
          ...(r.snapshot as object),
          tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
        },
      }),
      'snapshot.tools',
    ],
    [
      'a caller-supplied selected-tool list',
      (r: Record<string, unknown>) => ({
        ...r,
        snapshot: {
          ...(r.snapshot as object),
          prompt: { ...((r.snapshot as { prompt: object }).prompt), selectedTools: ['read'] },
        },
      }),
      'snapshot.prompt.selectedTools',
    ],
  ])('refuses %s by name rather than as a shape error', (_label, mutate, key) => {
    const parsed = parseInputPreparationRequestParams(mutate(validRequest()));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.code).toBe('unsupported_input');
    expect(parsed.detail).toContain(key);
  });

  it.each([
    ['an unknown top-level field', (r: Record<string, unknown>) => ({ ...r, runtimeIdentity: 'forged' })],
    ['a wrong format tag', (r: Record<string, unknown>) => ({ ...r, format: 'byok.input-preparation.request.v2' })],
    ['the RETIRED version 1', (r: Record<string, unknown>) => ({ ...r, version: 1 })],
    ['the RETIRED version 2', (r: Record<string, unknown>) => ({ ...r, version: 2 })],
    ['the RETIRED version 3', (r: Record<string, unknown>) => ({ ...r, version: 3 })],
    ['the RETIRED version 4', (r: Record<string, unknown>) => ({ ...r, version: 4 })],
    ['a future version', (r: Record<string, unknown>) => ({ ...r, version: 6 })],
    ['an unknown scope field', (r: Record<string, unknown>) => ({ ...r, scope: { ...scope, tenantId: 't' } })],
    ['a non-openai-completions api', (r: Record<string, unknown>) => ({ ...r, selection: { ...(r.selection as object), model: { ...((r.selection as { model: object }).model), api: 'anthropic-messages' } } })],
    // `samplingParams` is a real native model field that this wire deliberately
    // does NOT carry (the fork's composer leaves it undefined for a projected
    // provider, so it never participates in the session's model equality). It
    // stands where `compat` used to: that one is now a carried declaration.
    ['an unsupported model field', (r: Record<string, unknown>) => ({ ...r, selection: { ...(r.selection as object), model: { ...((r.selection as { model: object }).model), samplingParams: {} } } })],
    ['an unknown compat key', (r: Record<string, unknown>) => ({ ...r, selection: { ...(r.selection as object), model: { ...((r.selection as { model: object }).model), compat: { supportsStrictMode: true } } } })],
    ['an object tool choice', (r: Record<string, unknown>) => ({ ...r, selection: { ...(r.selection as object), options: { cacheRetention: 'none', maxTokens: 1, toolChoice: { type: 'function' } } } })],
    ['an assistant message', (r: Record<string, unknown>) => ({ ...r, snapshot: { ...(r.snapshot as object), messages: [{ role: 'assistant', content: 'hi', timestamp: 1 }] } })],
    ['multimodal message content', (r: Record<string, unknown>) => ({ ...r, snapshot: { ...(r.snapshot as object), messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }] } })],
    ['no messages at all', (r: Record<string, unknown>) => ({ ...r, snapshot: { ...(r.snapshot as object), messages: [] } })],
    ['an unknown snapshot field', (r: Record<string, unknown>) => ({ ...r, snapshot: { ...(r.snapshot as object), toolExecutors: {} } })],
    ['a permission mode outside the closed set', (r: Record<string, unknown>) => ({ ...r, permissionMode: 'yolo' })],
    ['a missing permission mode', (r: Record<string, unknown>) => { const { permissionMode: _mode, ...rest } = r; return rest; }],
    ['no required toolsets at all', (r: Record<string, unknown>) => ({ ...r, requiredToolsets: [] })],
    ['a duplicate toolset id', (r: Record<string, unknown>) => ({ ...r, requiredToolsets: ['team', 'team'] })],
    ['a non-string toolset id', (r: Record<string, unknown>) => ({ ...r, requiredToolsets: [7] })],
    ['an empty requestId', (r: Record<string, unknown>) => ({ ...r, requestId: '' })],
    ['an accounting ruling with an unknown field', (r: Record<string, unknown>) => ({ ...r, accountingPolicyRef: { ...accountingPolicyRef(), budget: 10 } })],
    ['an accounting ruling naming no runtime', (r: Record<string, unknown>) => { const { ruledRuntime: _runtime, ...rest } = accountingPolicyRef(); return { ...r, accountingPolicyRef: rest }; }],
    ['an accounting ruling naming no target', (r: Record<string, unknown>) => { const { ruledTarget: _target, ...rest } = accountingPolicyRef(); return { ...r, accountingPolicyRef: rest }; }],
    ['an accounting ruling repeating a residual key', (r: Record<string, unknown>) => ({ ...r, accountingPolicyRef: { ...accountingPolicyRef(), ruledResidualKeys: ['max_tokens', 'max_tokens'] } })],
    ['a null params value', () => null],
    ['an array params value', () => []],
  ])('rejects %s', (_label, mutate) => {
    const parsed = parseInputPreparationRequestParams(mutate(validRequest()) as Record<string, unknown>);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.code).toBe('bad_request');
  });

  it('carries the Host accounting ruling verbatim, and defaults none when it is absent', () => {
    const withoutRuling = parseInputPreparationRequestParams(validRequest());
    expect(withoutRuling.ok).toBe(true);
    if (!withoutRuling.ok) throw new Error('unreachable');
    // No default: a request that rules on nothing produces a request that says
    // so, and the receipt answers `accounting_policy_missing`.
    expect(withoutRuling.request.accountingPolicyRef).toBeUndefined();

    const parsed = parseInputPreparationRequestParams({ ...validRequest(), accountingPolicyRef: accountingPolicyRef() });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.request.accountingPolicyRef).toEqual(accountingPolicyRef());
  });

  it('gates lookup and cancel on exactly {requestId, scope}', () => {
    expect(parseInputPreparationLookupParams({ requestId: 'prep-1', scope })).toEqual({ requestId: 'prep-1', scope });
    expect(parseInputPreparationCancelParams({ requestId: 'prep-1', scope })).toEqual({ requestId: 'prep-1', scope });
    for (const parse of [parseInputPreparationLookupParams, parseInputPreparationCancelParams]) {
      expect(parse({ requestId: 'prep-1' })).toBeUndefined();
      expect(parse({ scope })).toBeUndefined();
      expect(parse({ requestId: 'prep-1', scope, reference: 'ref' })).toBeUndefined();
      expect(parse({ requestId: 'prep-1', scope: { ...scope, deviceId: '' } })).toBeUndefined();
    }
  });

  it('names the three methods the way every other unary method on this socket is named', () => {
    expect(INPUT_PREPARATION_PREPARE_METHOD).toBe('input_preparation.prepare');
    expect(INPUT_PREPARATION_LOOKUP_METHOD).toBe('input_preparation.lookup');
    expect(INPUT_PREPARATION_CANCEL_METHOD).toBe('input_preparation.cancel');
  });
});
