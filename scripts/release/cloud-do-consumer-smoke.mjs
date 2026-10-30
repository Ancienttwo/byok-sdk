import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeSmokeImports } from '../api-surface/entry-closure.mjs';
import { scanModule } from '../api-surface/module-scan.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The installed Worker consumer: the only @byok-sdk imports a Cloudflare Worker
// needs, so the README's Worker install set is checked against this list.
const workerSource = `import { AgentDO, DurableObjectSqliteDatabase, sessionObjectName } from '@byok-sdk/cloud-do';
import { validateResultOutcome } from '@byok-sdk/protocol';

export class ConsumerDO extends AgentDO {
  protected instructions(): string { return 'Consumer hook reached.'; }

  async probe() {
    const hook = this.instructions();
    const database = new DurableObjectSqliteDatabase(this.ctx.storage);
    try {
      await database.run('CREATE TABLE IF NOT EXISTS consumer_probe (value TEXT)');
      await database.run('INSERT INTO consumer_probe (value) VALUES (?)', hook);
      const row = await database.get<{ value: string }>('SELECT value FROM consumer_probe LIMIT 1');
      const objectName = await sessionObjectName({ tenantId: 'consumer', workspaceId: 'workspace', agentId: 'agent', sessionId: 'session' });
      const schema = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
      const valid = validateResultOutcome(schema, { answer: hook });
      const invalid = validateResultOutcome(schema, { answer: 1 });
      return { hook, stored: row?.value, objectName, valid, invalid };
    } finally { await database.close(); }
  }
}

export default {
  async fetch(_request: Request, env: { AGENTS: DurableObjectNamespace<ConsumerDO> }): Promise<Response> {
    return Response.json(await env.AGENTS.getByName('consumer').probe());
  },
};
`;
export const workerConsumerImports = [...new Set(scanModule(workerSource, { declaration: true }).imports.map(edge => edge.specifier))].sort();

function cliEntry(require, name, bin) {
  const manifestPath = require.resolve(name + '/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (!relative) throw new Error(name + ' has no ' + bin + ' CLI entry');
  return path.join(path.dirname(manifestPath), relative);
}

function runCli(entry, args, directory) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log'),
      NO_COLOR: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`consumer CLI failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function deadline(work, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cloudDoConsumerSmoke(installRoot, workerImports) {
  const rootRequire = createRequire(path.join(repoRoot, 'package.json'));
  const cloudRequire = createRequire(path.join(repoRoot, 'packages/cloud-do/package.json'));
  const installedRequire = createRequire(path.join(installRoot, 'package.json'));
  const manifestPath = installedRequire.resolve('@byok-sdk/cloud-do/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.name, '@byok-sdk/cloud-do');

  const consumer = path.join(installRoot, 'cloud-do-consumer');
  mkdirSync(consumer);
  const typesDir = path.dirname(cloudRequire.resolve('@cloudflare/workers-types/package.json'));
  const workersTypes = path.join(typesDir, 'index.d.ts');
  assert.ok(existsSync(workersTypes), 'the pinned Workers type entry must exist');
  writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    files: [workersTypes],
    include: ['worker.ts'],
  }, null, 2) + '\n');
  assert.deepEqual([...new Set([...workerImports, '@byok-sdk/protocol'])].sort(), workerConsumerImports,
    'every Worker export and the shared outcome validator must be covered by the installed consumer imports');
  writeFileSync(path.join(consumer, 'worker.ts'), workerSource);
  const flags = ['no_nodejs_compat', 'no_nodejs_compat_v2'];
  writeFileSync(path.join(consumer, 'wrangler.jsonc'), JSON.stringify({
    name: 'cloud-do-installed-consumer',
    main: 'worker.ts',
    compatibility_date: '2026-08-18',
    compatibility_flags: flags,
    durable_objects: { bindings: [{ name: 'AGENTS', class_name: 'ConsumerDO' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ConsumerDO'] }],
  }, null, 2) + '\n');

  runCli(cliEntry(rootRequire, 'typescript', 'tsc'), ['--project', 'tsconfig.json', '--noEmit'], consumer);
  console.log('[cloud-do-consumer] installed declarations typecheck passed');
  const out = path.join(consumer, 'out');
  runCli(cliEntry(cloudRequire, 'wrangler', 'wrangler'), ['deploy', '--dry-run', '--outdir', out], consumer);
  const modules = readdirSync(out).filter(name => name.endsWith('.js'));
  assert.equal(modules.length, 1, 'Wrangler must emit one bundled Worker entry');
  const bundle = readFileSync(path.join(out, modules[0]), 'utf8');
  const { Miniflare } = await import(pathToFileURL(cloudRequire.resolve('miniflare')).href);
  const mf = new Miniflare({
    resourcePersistencePath: path.join(consumer, 'state'),
    workers: [{ config: {
      name: 'cloud-do-installed-consumer',
      compatibilityDate: '2026-08-18',
      compatibilityFlags: flags,
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle } } },
      exports: { ConsumerDO: { type: 'durable-object', storage: 'sqlite' } },
      env: { AGENTS: { type: 'durable-object', worker: 'cloud-do-installed-consumer', exportName: 'ConsumerDO' } },
    } }],
  });
  try {
    await deadline(mf.ready, 60_000, 'workerd boot');
    const response = await deadline(mf.dispatchFetch('http://consumer/'), 10_000, 'consumer RPC');
    assert.equal(response.status, 200);
    const result = await deadline(response.json(), 10_000, 'consumer response');
    assert.equal(result.hook, 'Consumer hook reached.');
    assert.equal(result.stored, result.hook);
    assert.match(result.objectName, /^session:[a-f0-9]{64}$/);
    assert.deepEqual(result.valid, { ok: true, bytes: 35, canonical: { answer: result.hook } });
    assert.equal(result.invalid.ok, false);
    assert.equal(result.invalid.reason, 'schema-mismatch');
    // The validator reports the failing path from the root applicator down to
    // the leaf keyword.
    assert.deepEqual(result.invalid.issues.map(issue => [issue.pointer, issue.keyword]), [['', 'properties'], ['/answer', 'type']]);
    // The Worker bundle must decide exactly as the same installed package does on Node.
    const protocolManifestPath = installedRequire.resolve('@byok-sdk/protocol/package.json');
    const protocolEntry = JSON.parse(readFileSync(protocolManifestPath, 'utf8')).exports['.'].import;
    const { validateResultOutcome } = await import(pathToFileURL(path.join(path.dirname(protocolManifestPath), protocolEntry)).href);
    const schema = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
    assert.deepEqual(result.valid, validateResultOutcome(schema, { answer: result.hook }));
    assert.deepEqual(result.invalid, validateResultOutcome(schema, { answer: 1 }));
    console.log(`[cloud-do-consumer] ${process.platform}: installed Worker bundle, DO RPC, hook, identity, SQLite and shared outcome validation passed`);
  } finally {
    await deadline(mf.dispose(), 10_000, 'workerd disposal');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('provide the installed tarball consumer root');
  await cloudDoConsumerSmoke(path.resolve(process.argv[2]), runtimeSmokeImports(repoRoot).worker);
}
