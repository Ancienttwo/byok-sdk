import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';

// The nine published manifests. A contract test keeps this list equal to the
// non-private packages/*/package.json files.
export const publicManifests = Object.freeze([
  'client', 'cloud', 'cloud-dataplane', 'cloud-do', 'core', 'keys', 'protocol', 'server', 'ui-runtime',
].map(name => `packages/${name}/package.json`));

// #700 moves the exact undici pin from 8.11.2 to the patched 8.12.3. 8.12.2 is
// the first 8.x release that fixes the 2026-10-15 advisories. Each workspace
// below declares undici in exactly this manifest field.
const UNDICI_MOVE = { from: '8.11.2', to: '8.12.3' };
const UNDICI_FIELDS = { 'packages/client': 'dependencies', 'packages/cloud-dataplane': 'devDependencies' };
const UNDICI_LOCK = {
  from: ['undici@8.11.2', '', {}, 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ=='],
  to: ['undici@8.12.3', '', {}, 'sha512-+fdndUTwBP86cVjihTp21hZHo7d6oj1c/47XPA3lL8mM0XHs+C4EkcjmgRsFnFk2f/UONGDy9ItBItmXsLOQHw=='],
};
// Restore the reviewed old pin, so that the deep comparison still sees every other change.
function revertUndiciMove(before, after, field) {
  if (before?.[field]?.undici !== UNDICI_MOVE.from || after?.[field]?.undici !== UNDICI_MOVE.to) return false;
  after[field].undici = UNDICI_MOVE.from;
  return true;
}

// The Pi 1.4.0 ruling (docs/spec.md) moves the nine official Pi packages from
// exactly 1.3.0 to exactly 1.4.0 together: the root overrides, the client and
// cloud-do dependencies (with byok.piRuntimePin) and bun.lock. PI_LOCK holds the
// reviewed 1.4.0 lock rows, plus pi-tui's one new dependency.
const PI_MOVE = { from: '1.3.0', to: '1.4.0' };
export const PI_PACKAGES = ['chord', 'pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-durable', 'pi-mcp', 'pi-telemetry', 'pi-tui']
  .map(name => `@earendil-works/${name}`);
const PI_FIELDS = { 'packages/client': 'dependencies', 'packages/cloud-do': 'dependencies' };
export const PI_LOCK = {
  '@earendil-works/chord': ['@earendil-works/chord@1.4.0','',{'dependencies':{'@earendil-works/pi-telemetry':'1.4.0','typebox':'1.3.27'}},'sha512-dTbgyz4xgDS5KAUFx1bFENqj0Cr1N3tYxJJOYStc6g6HS78FSBZydyoCwLoddiQRF+VgRS0fpgAi+iKxjZ3BQA=='],
  '@earendil-works/pi-agent-core': ['@earendil-works/pi-agent-core@1.4.0','',{'dependencies':{'@earendil-works/pi-ai':'1.4.0','typebox':'1.3.27'}},'sha512-PoKY84SKUwnt7S5QBZaGUqfNO1kjP3KHpHUA9QpFTj4cOjaVWMYIcBPJ6FDRCdE8Zen9OSECQUd0uUfVgtSmgA=='],
  '@earendil-works/pi-ai': ['@earendil-works/pi-ai@1.4.0','',{'dependencies':{'@anthropic-ai/sdk':'0.129.0','@aws-sdk/client-bedrock-runtime':'3.1127.0','@earendil-works/pi-telemetry':'1.4.0','@google/genai':'2.21.0','@smithy/node-http-handler':'4.12.1','http-proxy-agent':'9.1.0','https-proxy-agent':'9.1.0','openai':'7.19.0','partial-json':'0.1.7','typebox':'1.3.27'},'bin':{'pi-ai':'dist/cli.js'}},'sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ=='],
  '@earendil-works/pi-codemode': ['@earendil-works/pi-codemode@1.4.0','',{'dependencies':{'quickjs-wasi':'3.6.2'}},'sha512-23CNAXpS9DuLzPMyYuvrXVVio46x4YhffCgCqaWmF7F5H8PooqjrQvX4ucF6M0BhUd+x2tV6r1J0dv8cCME4Cg=='],
  '@earendil-works/pi-coding-agent': ['@earendil-works/pi-coding-agent@1.4.0','',{'dependencies':{'@earendil-works/pi-agent-core':'1.4.0','@earendil-works/pi-ai':'1.4.0','@earendil-works/pi-codemode':'1.4.0','@earendil-works/pi-mcp':'1.4.0','@earendil-works/pi-tui':'1.4.0','@silvia-odwyer/photon-node':'0.3.4','brace-expansion':'5.0.12','chalk':'6.0.0','cross-spawn':'7.0.6','diff':'8.0.4','grok-mermaid':'0.2.3','highlight.js':'10.7.3','hosted-git-info':'9.0.3','ignore':'7.0.8','jiti':'2.7.0','minimatch':'10.2.6','proper-lockfile':'4.1.2','quickjs-wasi':'3.6.2','semver':'7.8.5','typebox':'1.3.27','undici':'8.10.2','yaml':'2.9.0'},'bin':{'pi':'dist/bundle/cli.js'}},'sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg=='],
  '@earendil-works/pi-durable': ['@earendil-works/pi-durable@1.4.0','',{'dependencies':{'@earendil-works/chord':'1.4.0','@earendil-works/pi-ai':'1.4.0','@earendil-works/pi-codemode':'1.4.0','@earendil-works/pi-telemetry':'1.4.0','@silvia-odwyer/photon':'0.3.3','diff':'8.0.4','typebox':'1.3.27'}},'sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q=='],
  '@earendil-works/pi-mcp': ['@earendil-works/pi-mcp@1.4.0','',{'dependencies':{'cross-spawn':'7.0.6'}},'sha512-92aZmmGsUpHHknYuKXZHRINQfahntw5hU9If0I0ZM49GojOaFHpkl5/GF3/aatqpt7v7GjZbBfpfSygGKW+pnw=='],
  '@earendil-works/pi-telemetry': ['@earendil-works/pi-telemetry@1.4.0','',{},'sha512-MLIfowwUYIY65jSjMX82paZOrX/NTvLk6D08h+3Jq42a99RzUOewzuCR0zOlPul3D6UBfddat76VT6LvsHEs1w=='],
  '@earendil-works/pi-tui': ['@earendil-works/pi-tui@1.4.0','',{'dependencies':{'get-east-asian-width':'1.6.0','marked':'18.0.11','marked-cjk-friendly':'0.1.2'}},'sha512-4obPOjgOD7g4mGSlngIvxyujC1UPdmyI9zdVthbr8GufacFEX+Ce0+scPgHg++k2xj5+QjESM2d5TxvIuzCVmg=='],
  'marked-cjk-friendly': ['marked-cjk-friendly@0.1.2','',{'peerDependencies':{'marked':'>=15.0.0'}},'sha512-GUj8HjiEbur9yhgUo52FBgKizggF1QtT6gVdrYdWW6ZB4lVVjgS3EyyXPyfyRD0V4ghGRPlO7MO80rgSWbm0eA=='],
};
const PI_ADDED = ['marked-cjk-friendly'];
// Restore the old pins only when every Pi package in this field moves exactly.
function revertPiMove(before, after, field) {
  const from = before?.[field], to = after?.[field];
  if (!plain(from) || !plain(to)) return false;
  const names = PI_PACKAGES.filter(name => name in from || name in to);
  if (!names.length || names.some(name => from[name] !== PI_MOVE.from || to[name] !== PI_MOVE.to)) return false;
  for (const name of names) to[name] = PI_MOVE.from;
  return true;
}

// #927 drops the protocol version from the server description and declares
// the cloud-do test edge to client (its tests import client source).
const SERVER_DESCRIPTION = Object.freeze({
  from: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, protocol v2, memory or single-process SQLite storage.',
  to: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, memory or single-process SQLite storage.',
});
const CLOUD_DO_CLIENT_EDGE = '@byok-sdk/client';

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// #793 D2 (owner O8): the private hosted (H) example. Its manifest has a fixed
// shape. It may only reuse workspaces and dependency specs that another
// workspace manifest already declares, so it adds no package and moves no version.
// #794 D3: the private Worker composition of H follows the same rule.
const HOSTED = Object.freeze({ dir: 'examples/hosted-bot-collaboration', name: '@byok-sdk/example-hosted-bot-collaboration' });
const HOSTED_WORKER = Object.freeze({ dir: 'examples/hosted-bot-collaboration-worker', name: '@byok-sdk/example-hosted-bot-collaboration-worker' });
const PRIVATE_HOSTED = Object.freeze([HOSTED, HOSTED_WORKER]);
const HOSTED_FIELDS = new Set(['name', 'version', 'private', 'type', 'description', 'scripts', 'dependencies', 'devDependencies']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
// #793 D2a-0: the K8 entries that the hosted example imports. There is no root
// entry, so H never loads the K8 host (src/host.ts). The K8 rules still import
// the K4 root, which loads HostLedger and node:sqlite.
const K8_HOSTED_EXPORTS = Object.freeze({
  './rules/commands': './src/rules/commands.ts',
  './rules/commit': './src/rules/commit.ts',
  './model': './src/model.ts',
  './coalesce': './src/coalesce.ts',
  './team': './src/team.ts',
  './test-support': './src/commit-vectors.test-support.ts',
});
// #884: the K4 entries before the I/O-free entry, and that entry. It exports only
// hash and canonical and imports only node:crypto, so K8 rules/ loads no ledger.
const K4_EXPORTS = Object.freeze({ '.': './src/index.ts', './test-support': './src/test-support.ts' });
const K4_CANONICAL_EXPORTS = Object.freeze({ './canonical': './src/canonical.ts' });
// #793 D2g: the K8 retention rule and its shared vectors, added to the hosted
// entries for H's retention slice (owner question §53d).
const K8_RETENTION_EXPORTS = Object.freeze({
  './retention': './src/retention.ts',
  './retention-vectors': './src/retention-vectors.test-support.ts',
});
// #793 D2f-1: the K8 Bot routine policy and its shared vectors, added to the
// hosted and retention entries. src/routines.ts does not load the K8 host.
const K8_ROUTINE_EXPORTS = Object.freeze({
  './routines': './src/routines.ts',
  './routine-vectors': './src/routine-vectors.test-support.ts',
});
// #793 D2b-out-1: the K8 channel and delivery rules and their shared vectors, added
// to the hosted, retention and routine entries (owner question §54b). They do not
// load the K8 host.
const K8_DELIVERY_EXPORTS = Object.freeze({
  './channel': './src/channel.ts',
  './delivery': './src/delivery.ts',
  './delivery-routing': './src/delivery-routing.ts',
  './delivery-vectors': './src/delivery-vectors.test-support.ts',
});
// #975 slice 2: the K8 owner switch format, added to the hosted, retention,
// routine and delivery entries. src/migration.ts has no I/O and does not load
// the K8 host.
const K8_MIGRATION_EXPORTS = Object.freeze({ './migration': './src/migration.ts' });
// #975 slice 5: the L side of the owner switch, added on top of the migration
// entry, so the H tests can import an H export into an L tenant
// (importForSwitch, commitImport). src/switch.ts loads the K4 root entry, and
// with it node:sqlite (ledger.ts) and node:async_hooks (core.ts); it does not
// load the K8 host. Only H tests import it; H's src does not.
const K8_SWITCH_EXPORTS = Object.freeze({ './switch': './src/switch.ts' });
/** The other workspace manifests, each with its dir. */
function otherWorkspaceManifests(cwd, self) {
  const manifests = [];
  for (const prefix of ['packages', 'examples']) {
    if (!existsSync(resolve(cwd, prefix))) continue;
    for (const name of readdirSync(resolve(cwd, prefix))) {
      const dir = `${prefix}/${name}`, file = resolve(cwd, dir, 'package.json');
      if (dir !== self && existsSync(file)) manifests.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return manifests;
}
function verifyHostedManifest(manifest, cwd, example) {
  if (!plain(manifest) || Object.keys(manifest).some(key => !HOSTED_FIELDS.has(key))
    || manifest.name !== example.name || manifest.private !== true || manifest.type !== 'module' || !version(manifest.version)
    || (manifest.description !== undefined && typeof manifest.description !== 'string')
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run' })) {
    throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
  }
  const others = otherWorkspaceManifests(cwd, example.dir);
  // A third-party spec must come from a workspace outside the private hosted examples, so they cannot vouch for each other.
  const declaring = others.filter(other => !PRIVATE_HOSTED.some(hosted => hosted.dir === other.dir));
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue;
    if (!plain(manifest[field])) throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
    for (const [name, spec] of Object.entries(manifest[field])) {
      const reused = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && others.some(other => other.manifest.name === name)
        : declaring.some(other => DEPENDENCY_FIELDS.some(declared => other.manifest[declared]?.[name] === spec));
      if (!reused) throw new Error(`Reviewed CI mapping required: the hosted example may only reuse a declared dependency spec (${name})`);
    }
  }
  return manifest;
}
/** Admits a private hosted example's own lock rows when they match its reviewed manifest. Every other lock byte stays compared. */
function admitHostedLock(before, after, cwd, example) {
  const entry = after.workspaces?.[example.dir];
  if (entry === undefined) return;
  const manifest = verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, example.dir, 'package.json'), 'utf8')), cwd, example);
  const expected = { name: manifest.name, version: manifest.version };
  for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
  const row = [`${example.name}@workspace:${example.dir}`];
  if (!isDeepStrictEqual(entry, expected) || !isDeepStrictEqual(after.packages?.[example.name], row)
    || (before.packages?.[example.name] !== undefined && !isDeepStrictEqual(before.packages[example.name], row))) {
    throw new Error('Reviewed CI mapping required: the hosted example lock rows differ from its manifest');
  }
  delete before.workspaces[example.dir]; delete after.workspaces[example.dir];
  if (before.packages) delete before.packages[example.name];
  delete after.packages[example.name];
}

/** Returns the workspaces whose suites must qualify a reviewed dependency move. */
export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  const hosted = PRIVATE_HOSTED.find(example => path === `${example.dir}/package.json`);
  if (hosted) {
    // A new file has no base content, so the reviewed shape is the whole check.
    verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), cwd, hosted);
    return [];
  }
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    // #603 pins both generated metadata and native build input bytes.
    // Admit only the reviewed additive LF rules, never unrelated attributes.
    const rule = 'packages/client/src/daemon/agent-memory-helper-release-pin.ts text eol=lf\n';
    const before = beforeText.replace(/\r\n/g, '\n');
    const after = afterText.replace(/\r\n/g, '\n');
    const nativeRules = 'packages/client/native/agent-memory-fs/*.go text eol=lf\n'
      + 'packages/client/native/agent-memory-fs/go.mod text eol=lf\n';
    const additions = [rule, nativeRules, rule + nativeRules];
    if (!additions.some(addition => after === before + addition
      && addition.trimEnd().split('\n').every(line => !before.split('\n').includes(line)))) {
      throw new Error('Reviewed CI mapping required: only the reviewed helper LF attributes may be added');
    }
    return [];
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return [];
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const qualify = [];
  const before = parse(beforeText), after = parse(afterText);
  if (path === 'bun.lock') {
    for (const example of PRIVATE_HOSTED) admitHostedLock(before, after, cwd, example);
    const piMoved = [];
    for (const [dir, record] of Object.entries(before.workspaces)) {
      if (dir === '') continue;
      const current = after.workspaces?.[dir];
      if (!current || !version(record.version) || !version(current.version)) throw new Error('Invalid workspace lock version');
      const manifest = JSON.parse(readFileSync(resolve(cwd, dir, 'package.json'), 'utf8'));
      if (current.version !== manifest.version) throw new Error('Lock version differs from workspace manifest');
      // #658 adds this existing workspace solely to the private mailbox fixture.
      // Normalize only that reviewed additive edge; all other lock bytes remain
      // subject to the deep comparison below (including resolved packages).
      if (dir === 'examples/bot-collaboration'
        && record.devDependencies?.['@byok-sdk/cloud'] === undefined
        && current.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*'
        && manifest.private === true
        && manifest.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
        delete current.devDependencies['@byok-sdk/cloud'];
      }
      // #603 exposes the already resolved bundler to helper asset smoke tests.
      if (dir === 'packages/client'
        && record.devDependencies?.esbuild === undefined
        && current.devDependencies?.esbuild === '0.28.1'
        && manifest.devDependencies?.esbuild === '0.28.1') {
        delete current.devDependencies.esbuild;
      }
      if (dir === 'packages/cloud-do'
        && record.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === undefined
        && current.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*'
        && manifest.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*') {
        delete current.devDependencies[CLOUD_DO_CLIENT_EDGE];
      }
      const undiciField = UNDICI_FIELDS[dir];
      if (undiciField && manifest[undiciField]?.undici === UNDICI_MOVE.to && revertUndiciMove(record, current, undiciField)) qualify.push(dir);
      const piField = PI_FIELDS[dir];
      if (piField && manifest[piField]?.['@earendil-works/pi-ai'] === PI_MOVE.to && revertPiMove(record, current, piField)) piMoved.push(dir);
      delete record.version; delete current.version;
    }
    // Both workspace pins and the resolved package move together, or nothing moves.
    if (qualify.length) {
      if (qualify.length !== Object.keys(UNDICI_FIELDS).length
        || !isDeepStrictEqual(before.packages?.undici, UNDICI_LOCK.from) || !isDeepStrictEqual(after.packages?.undici, UNDICI_LOCK.to)) {
        throw new Error('Reviewed CI mapping required: bun.lock must move both undici pins and the resolved undici entry together');
      }
      after.packages.undici = before.packages.undici;
    }
    // Every Pi pin, the overrides and the reviewed rows move together, or nothing moves.
    if (piMoved.length) {
      const rows = PI_PACKAGES.every(name => before.packages?.[name]?.[0] === `${name}@${PI_MOVE.from}` && isDeepStrictEqual(after.packages?.[name], PI_LOCK[name]))
        && PI_ADDED.every(name => before.packages?.[name] === undefined && isDeepStrictEqual(after.packages?.[name], PI_LOCK[name]));
      if (piMoved.length !== Object.keys(PI_FIELDS).length || !revertPiMove(before, after, 'overrides') || !rows) {
        throw new Error('Reviewed CI mapping required: bun.lock must move every Pi pin, the overrides and the reviewed Pi lock rows together');
      }
      for (const name of PI_PACKAGES) after.packages[name] = before.packages[name];
      for (const name of PI_ADDED) delete after.packages[name];
      qualify.push(...piMoved);
    }
  } else if (path === 'examples/bot-collaboration/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The bot collaboration fixture must stay private');
    // #658: the private fixture cloud edge.
    if (before.devDependencies?.['@byok-sdk/cloud'] === undefined && after.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
      delete after.devDependencies['@byok-sdk/cloud'];
    }
    // #793 D2a-0: the K8 entries for the hosted example.
    if (before.exports === undefined && isDeepStrictEqual(after.exports, K8_HOSTED_EXPORTS)) delete after.exports;
    // #793 D2g: the retention entries, only on top of exactly the hosted entries.
    if (isDeepStrictEqual(before.exports, K8_HOSTED_EXPORTS) && isDeepStrictEqual(after.exports, { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2f-1: the routine entries, only on top of exactly the hosted and retention entries.
    const retained = { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS };
    if (isDeepStrictEqual(before.exports, retained) && isDeepStrictEqual(after.exports, { ...retained, ...K8_ROUTINE_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2b-out-1: the delivery entries, only on top of exactly the hosted, retention and routine entries.
    const routed = { ...retained, ...K8_ROUTINE_EXPORTS };
    if (isDeepStrictEqual(before.exports, routed) && isDeepStrictEqual(after.exports, { ...routed, ...K8_DELIVERY_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 2: the migration entry, only on top of exactly the hosted, retention, routine and delivery entries.
    const delivered = { ...routed, ...K8_DELIVERY_EXPORTS };
    if (isDeepStrictEqual(before.exports, delivered) && isDeepStrictEqual(after.exports, { ...delivered, ...K8_MIGRATION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 5: the switch entry, only on top of exactly the entries up to and including the migration entry.
    const migrated = { ...delivered, ...K8_MIGRATION_EXPORTS };
    if (isDeepStrictEqual(before.exports, migrated) && isDeepStrictEqual(after.exports, { ...migrated, ...K8_SWITCH_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'examples/host-execution-core/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The host execution core example must stay private');
    // #884: only the ./canonical entry, only on top of exactly the existing entries.
    if (isDeepStrictEqual(before.exports, K4_EXPORTS) && isDeepStrictEqual(after.exports, { ...K4_EXPORTS, ...K4_CANONICAL_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'package.json') {
    // repo-harness owns its generated command scripts. Admit additions, removals
    // and edits whose old and new values both invoke repo-harness; every other
    // script and field stays in the deep comparison below.
    const harnessScript = value => typeof value === 'string' && value.startsWith('repo-harness ');
    for (const name of new Set([...Object.keys(before.scripts ?? {}), ...Object.keys(after.scripts ?? {})])) {
      const oldValue = before.scripts?.[name], newValue = after.scripts?.[name];
      if ((oldValue === undefined || harnessScript(oldValue)) && (newValue === undefined || harnessScript(newValue))) {
        delete before.scripts?.[name]; delete after.scripts?.[name];
      }
    }
    const oldCommand = before.scripts?.['test:scripts'], newCommand = after.scripts?.['test:scripts'];
    const prefix = 'node --test --test-concurrency=1 ';
    if (!oldCommand?.startsWith(prefix) || !newCommand?.startsWith(prefix)) throw new Error('Unreviewed test command');
    const oldTests = oldCommand.slice(prefix.length).split(' '), newTests = newCommand.slice(prefix.length).split(' ');
    let index = 0;
    for (const test of newTests) {
      if (test === oldTests[index]) { index++; continue; }
      if (!/^scripts\/ci\/[a-z0-9-]+\.test\.mjs$/.test(test) || oldTests.includes(test) || !existsSync(resolve(cwd, test))) throw new Error('Only existing CI contract tests may be added');
    }
    if (index !== oldTests.length || new Set(newTests).size !== newTests.length) throw new Error('Existing tests must remain in order without duplicates');
    delete before.scripts['test:scripts']; delete after.scripts['test:scripts'];
    if (revertPiMove(before, after, 'overrides')) qualify.push(...Object.keys(PI_FIELDS));
  } else {
    if (!version(before.version) || !version(after.version)) throw new Error('Invalid package version');
    if (path === 'packages/client/package.json'
      && before.devDependencies?.esbuild === undefined
      && after.devDependencies?.esbuild === '0.28.1') {
      delete after.devDependencies.esbuild;
    }
    if (path === 'packages/client/package.json') {
      const key = '#byok-hermes-session';
      const entry = { types: './dist/adapters/hermes/hermes-session-runtime.d.ts', default: './dist/adapters/hermes/hermes-session-runtime.js' };
      if (before.imports?.[key] === undefined && isDeepStrictEqual(after.imports?.[key], entry)) delete after.imports[key];
      const smoke = ' && node scripts/check-hermes-session-entry.mjs';
      if (typeof before.scripts?.build === 'string' && after.scripts?.build === before.scripts.build + smoke) after.scripts.build = before.scripts.build;
      // #635 adds the public transport-free test-double entry; its bundle is checked by check-adapters-entry.mjs.
      const testing = { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' };
      if (before.exports?.['./testing'] === undefined && isDeepStrictEqual(after.exports?.['./testing'], testing)) delete after.exports['./testing'];
    }
    if (path === 'packages/keys/package.json') {
      // #636 adds one subpath for the generated pinned pi-ai catalog lookup.
      const key = './pi-catalog';
      const entry = { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    if (path === 'packages/core/package.json') {
      // #654 adds one subpath for sealed payload v1, so the root bundle does not grow.
      const key = './sealed-payload';
      const entry = { types: './dist/sealed-payload/index.d.ts', import: './dist/sealed-payload/index.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    if (path === 'packages/server/package.json'
      && before.description === SERVER_DESCRIPTION.from && after.description === SERVER_DESCRIPTION.to) {
      after.description = before.description;
    }
    if (path === 'packages/cloud-do/package.json'
      && before.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === undefined
      && after.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*') {
      delete after.devDependencies[CLOUD_DO_CLIENT_EDGE];
      qualify.push('packages/cloud-do');
    }
    // #702 raises the public Node floor with the Node 24.22.1 pin. Admit only
    // this exact engines.node edit in a public manifest. Any other engines value
    // or key, and any other field, still fails the comparison below.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.15.0'
      && after.engines?.node === '>=24.22.1') {
      after.engines.node = before.engines.node;
    }
    const dir = path.slice(0, -'/package.json'.length);
    if (UNDICI_FIELDS[dir] && revertUndiciMove(before, after, UNDICI_FIELDS[dir])) qualify.push(dir);
    if (PI_FIELDS[dir] && revertPiMove(before, after, PI_FIELDS[dir])) {
      qualify.push(dir);
      if (dir === 'packages/client') {
        if (before.byok?.piRuntimePin !== PI_MOVE.from || after.byok?.piRuntimePin !== PI_MOVE.to) {
          throw new Error('Reviewed CI mapping required: packages/client/package.json must move byok.piRuntimePin with the Pi pins');
        }
        after.byok.piRuntimePin = PI_MOVE.from;
      }
    }
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
  return qualify;
}

/** A `bin:<name>` entry belongs to the one workspace package whose manifest declares that bin. */
function binOwner(name, cwd) {
  const owners = readdirSync(resolve(cwd, 'packages')).filter(dir => {
    const manifest = resolve(cwd, 'packages', dir, 'package.json');
    return existsSync(manifest) && Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {}, name);
  });
  if (owners.length !== 1) throw new Error(`Reviewed CI mapping required: unmapped API entry bin:${name}`);
  return `packages/${owners[0]}`;
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    const bin = /^bin:([a-z0-9-]+)$/.exec(key);
    if (bin) { owners.add(binOwner(bin[1], cwd)); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed CI mapping required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
