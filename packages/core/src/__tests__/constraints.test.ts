/**
 * The sprint S2.2 constraint list, made executable.
 *
 * These are the properties that are cheap to state, expensive to lose, and
 * invisible in a normal test run: a `@byok-sdk/protocol` import that quietly
 * recreates the `keys → protocol` edge (§12.1), a `node:` import that breaks
 * the Workers composition, a port method that forgot its tenant parameter, a
 * `TenantId` cast outside the mint point. None of them would fail a behavioral
 * test — they only show up as a broken deployment or a cross-tenant read much
 * later.
 *
 * "Shipped source" below means `src/**` minus `src/__tests__/**`: the test tree
 * is excluded from `tsconfig.build.json` and is never reachable from the tsup
 * entry, so it may use `node:fs` to do the scanning that proves the shipped
 * source does not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../index';
import { CORE_PORT_INTERFACES, CORE_PORT_METHODS } from '../ports-contract';

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
    files.push({
      path: `${prefix}${entry.name}`,
      text: readFileSync(new URL(entry.name, directory), 'utf8'),
    });
  }
  return files;
}

const ALL_SOURCES = listSources(SRC_URL);
const SHIPPED_SOURCES = ALL_SOURCES.filter((file) => !file.path.startsWith('__tests__/'));

/**
 * This file necessarily writes down every pattern it forbids, so it excludes
 * itself from the scans. Every other file in the package is in scope.
 */
const SCANNER = '__tests__/constraints.test.ts';

function read(path: string): string {
  const file = ALL_SOURCES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`No such source file: ${path}`);
  return file.text;
}

/** Drops comments so a scan sees declarations, not prose about declarations. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('dependency isolation', () => {
  it('declares zod as its only runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', SRC_URL), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(manifest['dependencies'] as object)).toEqual(['zod']);
    expect(manifest['peerDependencies']).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('@byok-sdk/protocol');
  });

  it('never references @byok-sdk/protocol in code', () => {
    // Not merely "no import statement": any code-level mention would be a step
    // toward one, and the whole point of §12.1 is that this edge stays absent.
    const offenders = ALL_SOURCES.filter(
      (file) => file.path !== SCANNER && /@byok\/protocol/.test(stripComments(file.text)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('never imports a node: builtin from shipped source', () => {
    const offenders = SHIPPED_SOURCES.filter((file) =>
      /from\s+'node:|require\('node:|import\('node:/.test(stripComments(file.text)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('never imports any other @byok package', () => {
    const offenders = ALL_SOURCES.filter((file) =>
      /from\s+'@byok\//.test(stripComments(file.text)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('reads time only through the injected clock', () => {
    const offenders = SHIPPED_SOURCES.filter((file) =>
      /Date\.now\(\)/.test(stripComments(file.text)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe('public API surface', () => {
  const ALLOWED_INDEX_MODULES = [
    './tenant',
    './principals',
    './errors',
    './time',
    './mailbox',
    './board',
    './truth',
    './presence',
    './blob',
    './quota',
    './attestation',
    './capabilities',
    './stores',
    './ports-contract',
    './in-memory/index',
  ];

  it('re-exports only contract, schema, error, and in-memory reference modules', () => {
    const sources = [...read('index.ts').matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
    expect([...new Set(sources)].sort()).toEqual([...ALLOWED_INDEX_MODULES].sort());
  });

  // S4A story O-005 answered this: the suite is the private `@byok-sdk/conformance`
  // workspace package, so core ships the port CONTRACT DATA the suite reads and
  // none of the harness that reads it.
  it('exports no conformance harness', () => {
    expect(stripComments(read('index.ts'))).not.toContain('__tests__');
    expect(Object.keys(publicApi)).not.toContain('runCoreConformance');
  });

  it('freezes the runtime export list', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'BOARD_STATUSES',
      'BOARD_TRANSITIONS',
      'ByokCoreError',
      'CANONICAL_TIMESTAMP_PATTERN',
      'CAPABILITY_DECLARATION_SCHEMA_ID',
      'CAPABILITY_NAME_PATTERN',
      'CONTENT_HASH_PATTERN',
      'CORE_ERROR_CODES',
      'CORE_PORT_INTERFACES',
      'CORE_PORT_METHODS',
      'CORE_STORE_NAMES',
      'CapabilityDeclarationSchema',
      'CoreConflictError',
      'DEFAULT_ACTIVITY_CAPACITY',
      'DEVICE_PROOF_ALGORITHMS',
      'DEVICE_PROOF_DOMAIN_PREFIX',
      'DEVICE_PROOF_SCHEMA_ID',
      'DEVICE_PROOF_VERSION',
      'DeviceProofEnvelopeV1Schema',
      'DeviceProofProtectedClaimsSchema',
      'IN_MEMORY_CLOCK_EPOCH',
      'InMemoryActivityStore',
      'InMemoryBoardStore',
      'InMemoryMailboxStore',
      'InMemoryObjectStore',
      'InMemoryPresenceStore',
      'InMemoryQuotaStore',
      'InMemoryTruthStore',
      'MAILBOX_MESSAGE_STATES',
      'OBJECT_KEY_PREFIX_PATTERN',
      'OBJECT_STATES',
      'OBJECT_STATE_TRANSITIONS',
      'PRESENCE_LEVELS',
      'PRINCIPAL_KINDS',
      'STORAGE_ERROR_CODES',
      'STORAGE_ERROR_HTTP_STATUS',
      'STORAGE_RESERVATION_STATES',
      'STORAGE_WRITE_KINDS',
      'STORAGE_WRITE_POSTURES',
      'TENANT_ID_MAX_LENGTH',
      'TENANT_KEY_SEPARATOR',
      'TRUTH_RECORD_KINDS',
      'assertCanonicalTimestamp',
      'assertCapability',
      'canonicalizeJson',
      'canonicalizeJsonBytes',
      'contentHash',
      'createInMemoryCoreCompositionWithClock',
      'createInMemoryCoreStores',
      'createMutableClock',
      'deviceProofCanonicalClaims',
      'deviceProofCanonicalJson',
      'deviceProofSigningInput',
      'hasCapability',
      'isCanonicalTimestamp',
      'isContentHash',
      'isControlPlanePrincipal',
      'isCoreConflictError',
      'isCoreError',
      'isDevicePrincipal',
      'isLegalBoardTransition',
      'isLegalObjectTransition',
      'isTenantId',
      'objectKeyPrefix',
      'parseCapabilityDeclaration',
      'parseDeviceProofEnvelope',
      'principalTenant',
      'tenantId',
      'tenantKey',
      'tenantObjectKey',
    ]);
  });
});

// ---------------------------------------------------------------------------
// I7: tenant-first, async method inventory, scanned from the source interfaces
// ---------------------------------------------------------------------------

function interfaceBody(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Interface ${name} not found`);
  const open = start + marker.length - 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced braces in interface ${name}`);
}

/** Splits an interface body into member declarations on top-level `;`. */
function members(body: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if ('({[<'.includes(char)) depth += 1;
    else if (')}]>'.includes(char)) depth -= 1;
    if (char === ';' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) result.push(current.trim());
  return result.filter((member) => member.length > 0);
}

interface MethodSignature {
  readonly name: string;
  readonly firstParam: string;
  readonly returnType: string;
}

function parseMethod(member: string): MethodSignature | undefined {
  const open = member.indexOf('(');
  if (open < 0) return undefined;
  const name = member.slice(0, open).trim();
  if (!/^\w+$/.test(name)) return undefined;

  let depth = 0;
  let close = -1;
  for (let index = open; index < member.length; index += 1) {
    const char = member[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return undefined;

  const params = member.slice(open + 1, close);
  let paramDepth = 0;
  let firstParam = '';
  for (const char of params) {
    if ('({[<'.includes(char)) paramDepth += 1;
    else if (')}]>'.includes(char)) paramDepth -= 1;
    if (char === ',' && paramDepth === 0) break;
    firstParam += char;
  }
  const rest = member.slice(close + 1).trim();
  return {
    name,
    firstParam: firstParam.trim().replace(/\s+/g, ' '),
    returnType: rest.startsWith(':') ? rest.slice(1).trim().replace(/\s+/g, ' ') : '',
  };
}

const PORT_SOURCE_FILES: Readonly<Record<string, string>> = {
  MailboxStore: 'mailbox.ts',
  BoardStore: 'board.ts',
  TruthStore: 'truth.ts',
  PresenceStore: 'presence.ts',
  ActivityStore: 'presence.ts',
  ObjectStore: 'blob.ts',
  QuotaStore: 'quota.ts',
};

describe('store port inventory (I7)', () => {
  it('declares exactly the ports the composition contract names', () => {
    const declared = SHIPPED_SOURCES.flatMap((file) =>
      [...file.text.matchAll(/export interface (\w+Store) \{/g)].map((match) => match[1]!),
    );
    expect(declared.sort()).toEqual(Object.values(CORE_PORT_INTERFACES).sort());
    expect(Object.keys(PORT_SOURCE_FILES).sort()).toEqual(
      Object.values(CORE_PORT_INTERFACES).sort(),
    );
  });

  for (const [portName, interfaceName] of Object.entries(CORE_PORT_INTERFACES)) {
    const methods = members(
      interfaceBody(stripComments(read(PORT_SOURCE_FILES[interfaceName]!)), interfaceName),
    ).map((member) => parseMethod(member));

    it(`${interfaceName} declares exactly the contracted methods`, () => {
      expect(methods.every((method) => method !== undefined)).toBe(true);
      expect(methods.map((method) => method!.name).sort()).toEqual(
        [...CORE_PORT_METHODS[portName as keyof typeof CORE_PORT_METHODS]].sort(),
      );
    });

    for (const method of methods) {
      it(`${interfaceName}.${method?.name ?? '<unparsed>'} is async and tenant-first`, () => {
        expect(method).toBeDefined();
        // A required, branded first parameter: no bare deviceId/taskId lookup
        // exists to be called by accident (§12.6.2 layer 3/5).
        expect(method!.firstParam).toBe('tenant: TenantId');
        expect(method!.returnType.startsWith('Promise<')).toBe(true);
      });
    }
  }
});

describe('tenant mint point', () => {
  it('casts to TenantId only inside tenant.ts', () => {
    const offenders = SHIPPED_SOURCES.filter(
      (file) => file.path !== 'tenant.ts' && /as TenantId\b/.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('casts to ContentHash only inside blob.ts', () => {
    const offenders = SHIPPED_SOURCES.filter(
      (file) => file.path !== 'blob.ts' && /as ContentHash\b/.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('mints tenant ids in test fixtures only through the factory', () => {
    const offenders = ALL_SOURCES.filter(
      (file) =>
        file.path.startsWith('__tests__/') &&
        file.path !== SCANNER &&
        /as TenantId\b/.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe('vocabulary isolation', () => {
  // Scans run over declarations, not prose: a module has to be able to explain
  // in a comment which vocabulary it is not allowed to use.
  const WIRE_STATES = /\b(Offered|Claimed|Running|AwaitApproval|Complete|Failed|Cancelled)\b/;
  const BOARD_STATUSES = /\b(todo|in_progress|in_review|done|closed)\b/;

  it('keeps wire execution state names out of the board modules', () => {
    for (const path of ['board.ts', 'in-memory/board.ts']) {
      expect(stripComments(read(path))).not.toMatch(WIRE_STATES);
    }
  });

  it('keeps board and wire state names out of the presence modules', () => {
    for (const path of ['presence.ts', 'in-memory/presence.ts']) {
      const code = stripComments(read(path));
      expect(code).not.toMatch(BOARD_STATUSES);
      expect(code).not.toMatch(WIRE_STATES);
    }
  });

  it('keeps presence level names out of the board modules', () => {
    const levels = /\b(online|thinking|offline)\b/;
    for (const path of ['board.ts', 'in-memory/board.ts']) {
      expect(stripComments(read(path))).not.toMatch(levels);
    }
  });
});

describe('quota contract vocabulary', () => {
  it('accepts numeric entitlements only, never plan names or prices', () => {
    const commercial = /\b(free|pro|premium|basic|starter|enterprise|tier|price|pricing|usd|cents|billing|subscription)\b/i;
    for (const path of ['quota.ts', 'in-memory/quota.ts']) {
      expect(stripComments(read(path))).not.toMatch(commercial);
    }
  });

  it('keeps every entitlement and usage byte field on bigint', () => {
    const body = interfaceBody(stripComments(read('quota.ts')), 'TenantStorageEntitlement');
    const usage = interfaceBody(stripComments(read('quota.ts')), 'TenantStorageUsage');
    for (const member of [...members(body), ...members(usage)]) {
      if (!/Bytes|Count/.test(member)) continue;
      expect(member.replace(/\s+/g, ' ')).toMatch(/: bigint$/);
    }
  });

  it('keeps the five stable storage error codes verbatim', () => {
    expect(read('quota.ts')).toContain('storage_object_too_large');
    expect(read('quota.ts')).toContain('storage_quota_exceeded');
    expect(read('quota.ts')).toContain('storage_reservation_expired');
    expect(read('quota.ts')).toContain('storage_integrity_mismatch');
    expect(read('quota.ts')).toContain('storage_write_suspended');
  });
});

describe('device proof', () => {
  it('carries the domain prefix literal', () => {
    expect(read('attestation.ts')).toContain('byok-device-proof-v1');
  });

  it('keeps crypto out of core: verification is an injected port', () => {
    const code = stripComments(read('attestation.ts'));
    expect(code).not.toMatch(/\bcrypto\b/);
    expect(code).toMatch(/export interface DeviceProofVerifier \{/);
  });

  it('keeps its golden outside the protocol golden', () => {
    const goldenFiles = readdirSync(new URL('./golden/', new URL('__tests__/', SRC_URL)));
    expect(goldenFiles).toContain('device-proof-v1.canonical.json');
  });
});
