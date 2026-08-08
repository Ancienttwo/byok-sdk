/**
 * The S4A-a constraint list, made executable.
 *
 * These are properties that are cheap to state, expensive to lose, and
 * invisible in a normal test run: a CI job deleted or renamed so the dataplane
 * suites quietly go back to skipping, a `DROP` reaching the runner, a `pg`
 * import leaking upward into the platform-neutral packages. None of them would
 * fail a behavioral test — they show up as missing coverage or a lost table
 * much later.
 *
 * "Shipped source" is `src/**` minus `src/__tests__/**`: the test tree is
 * excluded from `tsconfig.build.json` and unreachable from the tsup entry, so
 * it may read files to prove things about the source that does not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC_URL = new URL('../', import.meta.url);
const REPO_ROOT_URL = new URL('../../../../', import.meta.url);

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
const SHIPPED = ALL_SOURCES.filter((file) => !file.path.startsWith('__tests__/'));

/** This file necessarily writes down every pattern it forbids, so it excludes itself. */
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

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT_URL), 'utf8');
}

describe('the CI dataplane job', () => {
  const workflow = repoFile('.github/workflows/ci.yml');

  it('exists as a job that sets BYOK_REQUIRE_DATAPLANE', () => {
    // The whole point of the flag: with it set, a missing
    // BYOK_TEST_POSTGRES_URL is a hard failure rather than a skip. If this job
    // is ever deleted or renamed, the dataplane suites go back to skipping
    // everywhere and nothing else notices — so its existence is pinned here.
    expect(workflow).toMatch(/^ {2}dataplane:$/m);
    expect(workflow).toContain('BYOK_REQUIRE_DATAPLANE');
    expect(workflow).toContain('BYOK_TEST_POSTGRES_URL');
    // Both halves, because from S4A-c the conformance scope includes a blob
    // port whose Postgres composition signs against MinIO. A job carrying only
    // the database URL would hard-fail at import, which is the correct
    // behavior and a terrible thing to discover by pushing.
    expect(workflow).toContain('BYOK_TEST_S3_ENDPOINT');
  });

  it('starts the substrate with the same command the skip message prints', () => {
    expect(workflow).toContain('docker compose -f docker-compose.test.yml up -d --wait');
  });

  it('runs BOTH compositions of the cloud conformance suite', () => {
    // One assertion source, two compositions, one job: a divergence between
    // them has to be a failure here, not a discrepancy discovered later.
    expect(workflow).toContain('pnpm --filter @byok/cloud-postgres test');
    expect(workflow).toContain('pnpm --filter @byok/conformance test');
  });

  it('covers both supported Node majors', () => {
    const dataplaneJob = workflow.slice(workflow.indexOf('\n  dataplane:'));
    expect(dataplaneJob).toContain('node-version: [20, 22]');
  });
});

describe('the compose substrate', () => {
  const compose = repoFile('docker-compose.test.yml');

  it('defines both dataplane services', () => {
    expect(compose).toMatch(/^ {2}postgres:$/m);
    expect(compose).toMatch(/^ {2}minio:$/m);
  });

  it('healthchecks both, so --wait means something', () => {
    expect(compose.match(/healthcheck:/g)).toHaveLength(2);
  });

  it('persists nothing, so every run starts from an empty database', () => {
    // A named volume would make "fresh install + migrate-up" depend on whoever
    // last ran `down -v`.
    expect(compose).not.toContain('volumes:');
  });
});

describe('the deployment surface', () => {
  const sample = repoFile('deploy/env/hosted.env.example');

  /** Every `KEY=VALUE` line, comments and blanks dropped. */
  const assignments = sample
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return { key: line.slice(0, separator), value: line.slice(separator + 1) };
    });

  it('carries a non-trivial set of assignments', () => {
    expect(assignments.length).toBeGreaterThan(5);
    for (const { key } of assignments) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('holds no value that could be a real credential', () => {
    // `deploy/` is tracked, so a secret committed here is a secret published.
    // Two shapes are allowed: an explicit `REPLACE_` placeholder, or a value
    // that is plainly not a secret (a region, a byte count, a capability list).
    // Anything with a long unbroken run of credential-shaped characters — a
    // base64 key, a hex token, an access key id — is neither.
    for (const { key, value } of assignments) {
      if (value.includes('REPLACE_')) continue;
      expect(value, `${key} is neither a placeholder nor obviously non-secret`).not.toMatch(
        /[A-Za-z0-9+/=]{20,}/,
      );
    }
  });

  it('declares the capabilities an object-storage composition can actually serve', () => {
    // The split's operational consequence: a deployment whose bytes live in R2
    // has no byte-proxy path, so `blobs.contentproxy` must NOT appear here. The
    // routes would not mount either way — a proxy is required as well as a
    // declaration — but a sample that over-declares teaches the wrong thing.
    const capabilities = assignments.find((entry) => entry.key === 'BYOK_CAPABILITIES');
    expect(capabilities?.value).toContain('blobs.presigned');
    expect(capabilities?.value).not.toContain('blobs.contentproxy');
  });

  it('ships a migrate script that runs the runner and nothing else', () => {
    const script = repoFile('deploy/scripts/migrate');
    expect(script.startsWith('#!')).toBe(true);
    expect(script).toContain('DATABASE_URL');
    // The runner owns ordering, locking, transactions, the ledger, and the
    // checksum check. A script that reimplemented any of it would be a second
    // source of truth about how this schema moves.
    expect(script).toContain('migrate(pool');
    expect(script).not.toMatch(/\bDROP\b/i);
    expect(script).not.toMatch(/\bpsql\b/);
  });
});

describe('the migration runner', () => {
  const runner = shipped('migrate.ts');

  it('has no down, drop, or truncate path', () => {
    // Rollback is "revert the application, leave the tables" (sprint S4A.6). A
    // destructive path that exists is a destructive path that eventually runs.
    expect(runner).not.toMatch(/\bDROP\b/i);
    expect(runner).not.toMatch(/\bTRUNCATE\b/i);
    expect(runner).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(runner).not.toMatch(/\bdown\b/i);
  });

  it('carries exactly one CREATE TABLE: the ledger it bootstraps', () => {
    // Every other table belongs to a file under `deploy/sql/`. Two sources of
    // schema truth is the failure this pins.
    expect(runner.match(/CREATE TABLE/gi)).toHaveLength(1);
    expect(runner).toContain('byok_schema_migration');
  });

  it('applies each file and its ledger row in one transaction', () => {
    expect(runner).toContain("'BEGIN'");
    expect(runner).toContain("'COMMIT'");
    expect(runner).toContain("'ROLLBACK'");
  });

  it('takes and releases the advisory lock', () => {
    expect(runner).toContain('pg_advisory_lock');
    expect(runner).toContain('pg_advisory_unlock');
  });
});

describe('dependency boundaries', () => {
  it('scans a non-trivial source tree', () => {
    expect(SHIPPED.length).toBeGreaterThan(8);
    expect(ALL_SOURCES.some((file) => file.path === SCANNER)).toBe(true);
  });

  it('imports nothing outside core, cloud, pg, aws4fetch, fast-xml-parser, and node builtins', () => {
    // `aws4fetch` is a single-file WebCrypto SigV4 signer, chosen over
    // `@aws-sdk/client-s3` for five actions' worth of need: a hundred
    // transitive packages is the smaller half of the objection, and the AWS
    // SDK's ambient credential provider chain — an authorization source nobody
    // configured — is the larger one (design §3).
    // ListObjectsV2 is the one S4B-c surface aws4fetch does not decode. The
    // dedicated XML dependency keeps pagination fail-closed without replacing
    // the signer or importing the AWS SDK credential-provider graph.
    const allowed = new Set([
      '@byok/core',
      '@byok/cloud',
      'pg',
      'aws4fetch',
      'fast-xml-parser',
    ]);
    for (const file of SHIPPED) {
      for (const [, specifier] of code(file.text).matchAll(/from\s+'([^']+)'/g)) {
        if (specifier === undefined) continue;
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        expect(allowed, `${file.path} imports ${specifier}`).toContain(specifier);
      }
    }
  });

  it('keeps the pg dependency out of the platform-neutral packages', () => {
    // `@byok/core` and `@byok/cloud` have to stay loadable on Workers, which is
    // the entire reason this package exists as a separate one.
    for (const manifest of ['packages/core/package.json', 'packages/cloud/package.json']) {
      expect(repoFile(manifest), manifest).not.toContain('"pg"');
    }
  });

  it('holds no module-level mutable binding', () => {
    for (const file of SHIPPED) {
      const moduleLevelMutable = code(file.text)
        .split('\n')
        .filter((line) => /^(let|var)\s/.test(line));
      expect(moduleLevelMutable, file.path).toEqual([]);
    }
  });
});

describe('tenant plumbing', () => {
  it('brands a TenantId only where a database row becomes a record', () => {
    // The stores are the boundary between an untyped `text` column and core's
    // branded identity. Anywhere else, a cast would be a tenant conjured from
    // a value nobody validated.
    const offenders = SHIPPED.filter(
      (file) => !file.path.startsWith('stores/') && /as TenantId\b/.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('reads time through the injected clock, never the database', () => {
    // `now()` in a store would make every TTL unassertable under a test clock,
    // and the conformance suite's expiry dimensions would have to sleep.
    // The lookbehind is what distinguishes SQL's `now()` from the injected
    // clock's `this.#clock.now()` and the `#now()` helper that wraps it, which
    // are the calls these stores are REQUIRED to make.
    for (const file of SHIPPED.filter((candidate) => candidate.path.startsWith('stores/'))) {
      expect(code(file.text), file.path).not.toMatch(/(?<![.\w#])now\s*\(\)/i);
      expect(code(file.text), file.path).not.toMatch(/Date\.now\(\)/);
    }
  });
});
