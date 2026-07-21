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

describe('control-protocol: endpoint path derivation', () => {
  it('controlSocketPath uses <storeDir>/control.sock when comfortably short', () => {
    expect(controlSocketPath('/Users/me/.byok/acme')).toBe('/Users/me/.byok/acme/control.sock');
  });

  it('controlSocketPath falls back to a short, deterministic tmpdir path once the natural path would be too long, nested under a private per-daemon subdirectory (not a bare file directly in the shared tmpdir)', () => {
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
