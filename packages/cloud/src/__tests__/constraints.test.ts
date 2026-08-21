/**
 * The S3a constraint list, made executable.
 *
 * These are properties that are cheap to state, expensive to lose, and
 * invisible in a normal test run: a `@byok-sdk/server` import that quietly turns
 * the hosted surface into a wrapper around the embedded coordinator, a `node:`
 * import that breaks the Workers composition, a module-level `Map` that turns
 * a stateless handler into a single-instance one, a `TenantId` threaded
 * through a handler by hand instead of through the facade. None of them would
 * fail a behavioral test — they show up as a broken deployment, or a
 * cross-tenant read, much later.
 *
 * "Shipped source" is `src/**` minus `src/__tests__/**`: the test tree is
 * excluded from `tsconfig.build.json` and unreachable from the tsup entry, so
 * it may use `node:fs` to do the scanning that proves the shipped source does
 * not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../index';

const SRC_URL = new URL('../', import.meta.url);

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function listSources(directory: URL, prefix = ''): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...listSources(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    files.push({ path: `${prefix}${entry.name}`, text: readFileSync(new URL(entry.name, directory), 'utf8') });
  }
  return files;
}

const ALL_SOURCES = listSources(SRC_URL);
const SHIPPED = ALL_SOURCES.filter((file) => !file.path.startsWith('__tests__/'));

/** This file necessarily writes down every pattern it forbids, so it excludes itself from the scans. */
const SCANNER = '__tests__/constraints.test.ts';

/** Drops comments so a scan sees declarations, not prose about declarations. */
function code(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

function shipped(path: string): string {
  const file = SHIPPED.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`No such shipped source file: ${path}`);
  return code(file.text);
}

describe('dependency boundaries', () => {
  it('scans a non-trivial source tree', () => {
    expect(SHIPPED.length).toBeGreaterThan(15);
    expect(ALL_SOURCES.some((file) => file.path === SCANNER)).toBe(true);
  });

  it('never imports @byok-sdk/server', () => {
    for (const file of SHIPPED) {
      expect(code(file.text), file.path).not.toContain('@byok-sdk/server');
    }
  });

  it('never imports a node: builtin', () => {
    for (const file of SHIPPED) {
      expect(code(file.text), file.path).not.toMatch(/from\s+'node:/);
      expect(code(file.text), file.path).not.toMatch(/require\(\s*'node:/);
    }
  });

  it('declares only @byok-sdk/core, @byok-sdk/protocol, hono, and zod', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@byok-sdk/core', '@byok-sdk/protocol', 'hono', 'zod']);
  });

  it('imports nothing outside those four packages', () => {
    const allowed = new Set(['@byok-sdk/core', '@byok-sdk/protocol', 'hono', 'zod']);
    for (const file of SHIPPED) {
      for (const [, specifier] of code(file.text).matchAll(/from\s+'([^']+)'/g)) {
        if (specifier === undefined) continue;
        if (specifier.startsWith('.')) continue;
        expect(allowed, `${file.path} imports ${specifier}`).toContain(specifier);
      }
    }
  });
});

describe('statelessness', () => {
  it('holds no module-level mutable binding anywhere in the shipped source', () => {
    for (const file of SHIPPED) {
      const moduleLevelMutable = code(file.text)
        .split('\n')
        .filter((line) => /^(let|var)\s/.test(line));
      expect(moduleLevelMutable, file.path).toEqual([]);
    }
  });

  it('keeps every Map/Set inside a store class, never in a handler, router, facade, or composition', () => {
    const stateful = SHIPPED.filter((file) => /new\s+(Map|Set)\s*[<(]/.test(code(file.text))).map((file) => file.path);
    for (const path of stateful) {
      expect(path.startsWith('stores/in-memory/'), `unexpected in-process collection in ${path}`).toBe(true);
    }
    // The scan has to be able to see one, or it proves nothing.
    expect(stateful.length).toBeGreaterThan(0);
  });

  it('has no session, connection, or Running map', () => {
    for (const file of SHIPPED) {
      const text = code(file.text);
      expect(text, file.path).not.toMatch(/\bRunning\b/);
      expect(text, file.path).not.toMatch(/\b(sessions|connections|activeTasks|waiters)\b/);
    }
  });

  it('holds no long-poll waiter registry: the hold is a bounded re-read', () => {
    const events = shipped('handlers/events.ts');
    // No collection to park a pending request in, and exactly one `new
    // Promise` — the sleep between re-reads. A waiter registry needs both a
    // place to store the resolver and a second promise to hand back.
    expect(events).not.toMatch(/new\s+(Map|Set)\s*[<(]/);
    expect(events.match(/new Promise/g)).toHaveLength(1);
    expect(events).toContain('readAfter');
    expect(events).toContain('setTimeout');
  });

  it('resolves the tenant from the request on every device route, never from a cache', () => {
    const shared = shipped('handlers/shared.ts');
    expect(shared).toContain('authenticateBearer');
    expect(shared).toContain('tenantStoresFor');
  });
});

describe('tenant plumbing', () => {
  it('names no TenantId inside a handler', () => {
    for (const file of SHIPPED.filter((candidate) => candidate.path.startsWith('handlers/'))) {
      expect(code(file.text), file.path).not.toContain('TenantId');
    }
  });

  it('builds the facade only from a principal', () => {
    const facade = shipped('tenant-stores.ts');
    expect(facade).toMatch(/export function tenantStoresFor\(\s*principal: Principal/);
    // One mint point for the bound tenant: core's `principalTenant`.
    expect(facade).toContain('principalTenant(principal)');
    expect(facade.match(/const tenant =/g)).toHaveLength(1);
  });

  it('keeps every pre-tenant method off the facade, port or proxy', () => {
    // Two of these are the documented pre-tenant exceptions on `CloudStores`;
    // the other three are `BlobContentProxy`, which is not a port at all and
    // must be no more reachable from a handler than they are.
    const facade = shipped('tenant-stores.ts');
    for (const method of ['resolveByDeviceId', 'redeem(', 'verifySignedUrl', 'writeContent', 'readContent']) {
      expect(facade, method).not.toContain(method);
    }
  });

  it('never lets a byte proxy onto the port bundle', () => {
    // The whole point of the split: `CloudStores` stays all-or-nothing, and
    // "this composition cannot carry bytes" is expressed by the proxy being
    // absent from `createByokCloud`'s options — not by another port, and not by
    // three methods that throw.
    const ports = shipped('stores/ports.ts');
    const bundle = ports.slice(ports.indexOf('export interface CloudStores {'));
    expect(bundle).not.toContain('BlobContentProxy');
    expect(bundle).not.toContain('contentProxy');
  });

  it('reaches the pre-tenant device lookup from authentication compositions only', () => {
    // The two files that DECLARE the method are excluded, not the ones that
    // call it: `ports.ts` states the signature, `ports-contract.ts` states the
    // method inventory. Naming a method in a contract is not reaching for it.
    const declarations = new Set(['stores/ports.ts', 'stores/ports-contract.ts']);
    const callers = SHIPPED.filter(
      (file) => !declarations.has(file.path) && /resolveByDeviceId/.test(code(file.text)),
    ).map((file) => file.path);
    expect(callers.sort()).toEqual([
      'auth/device-assertion.ts',
      'auth/plane.ts',
      'stores/in-memory/device-directory.ts',
    ]);
  });
});

describe('coordination vocabulary isolation', () => {
  it('keeps board status literals out of the frozen wire ingress module', () => {
    const inbound = shipped('inbound.ts');
    for (const status of ['todo', 'in_progress', 'in_review', 'done', 'closed']) {
      expect(inbound, status).not.toContain(`'${status}'`);
    }
  });

  it('keeps wire message and execution-state vocabulary out of the board projection', () => {
    const projection = shipped('board-projection.ts');
    expect(projection).not.toContain('task.complete');
    expect(projection).not.toContain('task.fail');
    for (const state of ['Offered', 'Claimed', 'Running', 'AwaitApproval', 'CancelRequested', 'Complete', 'Failed', 'Cancelled']) {
      expect(projection, state).not.toContain(state);
    }
  });
});

describe('the public surface', () => {
  it('exports the composition entry points the contract names', () => {
    expect(typeof publicApi.createByokCloud).toBe('function');
    expect(typeof publicApi.createInMemoryByokCloud).toBe('function');
    expect(typeof publicApi.tenantStoresFor).toBe('function');
    expect(typeof publicApi.handleInboundEnvelope).toBe('function');
    expect(typeof publicApi.createWebCrypto).toBe('function');
    expect(publicApi.NONCE_SIGNING_DOMAIN).toBe('byok-nonce-v1\n');
  });

  it('exports every cloud-local port name', () => {
    expect([...publicApi.CLOUD_STORE_NAMES]).toEqual([
      'activity',
      'approvals',
      'devices',
      'pairingCodes',
      'nonces',
      'dedup',
      'tasks',
      'cancellations',
      'receipts',
      'proofReceipts',
      'blobs',
      'rateLimiter',
    ]);
  });

  it('exposes no naked cross-tenant lookup', () => {
    for (const exported of Object.keys(publicApi)) {
      expect(exported).not.toMatch(/resolveByDeviceId|redeemPairingCode/);
    }
  });
});
