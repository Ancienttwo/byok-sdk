// The jiti seed of the embedded pi-subagents extension graphs (#1927).
//
//   node build-pi-jiti-seed.mjs
//     Transform the supported graphs once with the pinned jiti against a
//     canonical root and write templates plus a manifest to
//     dist/assets/sdk-derived/pi-jiti-seed/<sha256 of manifest>/.
//   node build-pi-jiti-seed.mjs --verify-installed <installRoot>
//     Release gate for an isolated install of the packed tarballs: the
//     installed client carries exactly the seed regenerated from the installed
//     pi-subagents and jiti, bound to bun.lock and the official Pi
//     closureDigest; copyPiRuntimeAssets copies it unchanged; and a fresh
//     execution in which the installed dist's own materializer seeds it
//     leaves jiti zero transforms.
//   node build-pi-jiti-seed.mjs --gate <piAssetRoot> [<materializerModule>]
//     The zero-transform gate alone, for any Pi asset root: in a fresh
//     execution (--zero-transform), materialize every group with the module's
//     usePiJitiSeed (this source tree's by default), then count the transforms
//     a jiti loader created beside that module, with jiti's default cache
//     choice, still requests. Fails unless zero.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { parse } from 'acorn';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PI_JITI_SEED_CANONICAL_ROOT, PI_JITI_SEED_DIR, PI_JITI_SEED_FORMAT, PI_JITI_SEED_VERSION,
  canonicalSeedFile, fileUrlLiteral, piJitiFilename, piJitiSeedFile, piSubagentHostPeersSource, piSubagentHostSdkSource, sha256,
} from '../src/adapters/pi/jiti-seed.mjs';
import { OFFICIAL_PI_PROVENANCE } from '../src/adapters/pi/official-pi-installation.mjs';
import { parseBunLock } from '../../../scripts/release/pi-runtime-identity.mjs';

const client = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(client, '../..');
/** The entry of each pi-subagents graph: the parent extension, and the Bun background runner. */
const GRAPHS = Object.freeze({ parent: 'bundle/index.js', runner: 'src/runs/background/binary-bootstrap.js' });
const SOURCE_MATERIALIZER = fileURLToPath(new URL('../src/adapters/pi/jiti-seed.mjs', import.meta.url));

/** The installed package `name` that Node resolution finds from `fromDir`. */
function installed(fromDir, name) {
  for (const base of createRequire(path.join(fromDir, 'package.json')).resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, 'package.json'))) return { dir: realpathSync(dir), manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) };
  }
  throw new Error(`build-pi-jiti-seed: ${name} is not installed beside ${fromDir}`);
}

/** Literal import/require edges, including lazy imports, without matching comments. */
function moduleEdges(source) {
  const edges = [];
  const visit = node => {
    if (node === null || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
      && typeof node.source?.value === 'string') edges.push({ id: node.source.value, async: true });
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
      && typeof node.arguments[0]?.value === 'string') edges.push({ id: node.arguments[0].value, async: false });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === 'object') visit(value);
    }
  };
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }));
  return edges;
}

/**
 * The disk graph jiti can reach when SEA's native import only accepts builtins.
 * Virtual Pi peers stay in the host. Package imports and their require closure
 * are included even when Node can normally load them without a transform.
 * Both async and CJS evaluations get their own cache entry, as jiti keys them.
 */
export function diskGraph(pkg, entry, peers, createJiti) {
  const seen = new Set(), pending = [{ path: entry, file: path.join(pkg, entry), async: true }], inputs = [];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const key = `${item.path}:${item.async}`;
    if (seen.has(key) || !/\.[cm]?js$/u.test(item.file)) continue;
    seen.add(key);
    const source = readFileSync(item.file, 'utf8');
    inputs.push({ ...item, source, ts: false, root: 'pi-subagents' });
    const resolver = createJiti(item.file, { fsCache: false, moduleCache: false });
    for (const edge of moduleEdges(source)) {
      if (edge.id.startsWith('node:') || builtinModules.includes(edge.id) || peers.has(edge.id)) continue;
      // jiti 2.7.0 always loads its own loader and TypeScript natively.
      if (/^(?:jiti|typescript)(?:\/|$)/u.test(edge.id)) continue;
      // These public APIs call jitiResolve with the edge's runtime async mode.
      const parentURL = pathToFileURL(item.file).href;
      const resolved = edge.async ? fileURLToPath(resolver.esmResolve(edge.id, { parentURL })) : resolver.resolve(edge.id, { parentURL });
      let relative;
      if (edge.id.startsWith('.')) relative = path.posix.join(path.posix.dirname(item.path), path.relative(path.dirname(item.file), resolved).split(path.sep).join('/'));
      else {
        const parts = edge.id.split('/'), name = parts.slice(0, edge.id.startsWith('@') ? 2 : 1).join('/');
        const dependency = installed(path.dirname(item.file), name);
        relative = path.posix.join('node_modules', name, path.relative(dependency.dir, resolved).split(path.sep).join('/'));
      }
      pending.push({ path: relative, file: resolved, async: edge.async });
    }
  }
  return inputs.sort((a, b) => a.path.localeCompare(b.path, 'en') || Number(a.async) - Number(b.async));
}

/** All supported source roots, derived from package edges and SDK build outputs. */
async function seedInputs(subagentsDir, extensionsDir, hostSdkSource, createJiti) {
  const { HOST_PEER_ALIASES } = await import(pathToFileURL(path.join(subagentsDir, 'src/runs/background/runner-aliases.js')).href);
  const peers = new Set(HOST_PEER_ALIASES.map(alias => alias.specifier));
  const inputs = [
    ...Object.entries(GRAPHS).flatMap(([group, entry]) => diskGraph(subagentsDir, entry, peers, createJiti).map(input => ({ ...input, group }))),
    ...readdirSync(extensionsDir).filter(file => /^pi-subagent-.*\.js$/u.test(file)).sort().map(file => ({
      group: 'parent', root: 'pi-subagent-extensions', path: file, async: true, ts: false, source: readFileSync(path.join(extensionsDir, file), 'utf8'),
    })),
    { group: 'parent', root: 'host-sdk', path: 'index.js', async: true, ts: false, source: hostSdkSource },
    { group: 'host-peers', root: 'host-peers', path: 'host-peers.ts', async: true, ts: true,
      source: piSubagentHostPeersSource(HOST_PEER_ALIASES.filter(alias => !alias.optional).map(alias => alias.specifier)) },
  ];
  const seen = new Set();
  return inputs.filter(input => {
    const key = `${input.root}/${input.path}:${input.async}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lockedIntegrity(lock, name, version) {
  const entry = lock.packages?.[name];
  assert.ok(Array.isArray(entry) && entry[0] === `${name}@${version}` && /^sha512-/u.test(entry[3]), `bun.lock has no ${name}@${version} integrity`);
  return entry[3];
}

/** The deterministic seed of `subagentsDir` with the jiti in `jitiDir`. */
async function generate(subagentsDir, jitiDir, sdkBin) {
  const subagents = JSON.parse(readFileSync(path.join(subagentsDir, 'package.json'), 'utf8'));
  const jitiVersion = JSON.parse(readFileSync(path.join(jitiDir, 'package.json'), 'utf8')).version;
  const lock = parseBunLock(readFileSync(path.join(repo, 'bun.lock'), 'utf8'));
  const { createJiti } = createRequire(path.join(jitiDir, 'package.json'))(path.join(jitiDir, 'lib', 'jiti.cjs'));
  const jiti = createJiti(path.join(client, 'package.json'), { fsCache: false, moduleCache: false });
  const officialPi = installed(sdkBin, '@earendil-works/pi-coding-agent');
  const pi = await import(pathToFileURL(path.join(officialPi.dir, officialPi.manifest.exports['.'].import)).href);
  const inputs = await seedInputs(subagentsDir, sdkBin, piSubagentHostSdkSource(pi), createJiti);
  const templates = new Map();
  const entries = inputs.map((input, index) => {
    const canonical = canonicalSeedFile(input.root, input.path);
    const code = jiti.transform({ filename: canonical, source: input.source, ts: input.ts, async: input.async, jsx: false });
    const siteLiteral = fileUrlLiteral(canonical);
    const sites = [];
    for (let at = code.indexOf(siteLiteral); at !== -1; at = code.indexOf(siteLiteral, at + siteLiteral.length)) sites.push(at);
    // Any other mention of the canonical root would be relocated by nothing.
    assert.equal(code.split(PI_JITI_SEED_CANONICAL_ROOT.slice(1)).length - 1, sites.length, `unrelocatable canonical path in ${input.group}/${input.path}`);
    const template = `templates/${String(index).padStart(3, '0')}.js`;
    templates.set(template, code);
    return { group: input.group, root: input.root, path: input.path, ts: input.ts, async: input.async, sourceSha256: sha256(input.source),
      template, templateSha256: sha256(code), siteLiteral, sites };
  });
  const manifest = Buffer.from(JSON.stringify({
    format: PI_JITI_SEED_FORMAT, version: PI_JITI_SEED_VERSION,
    piSubagents: `${subagents.name}@${subagents.version}`, jiti: jitiVersion,
    // Input trust chain: the locked tarballs and the official Pi closure this seed was derived beside.
    integrity: { [subagents.name]: lockedIntegrity(lock, subagents.name, subagents.version), jiti: lockedIntegrity(lock, 'jiti', jitiVersion) },
    piClosureDigest: OFFICIAL_PI_PROVENANCE.closureDigest,
    canonicalRoot: PI_JITI_SEED_CANONICAL_ROOT, entries,
  }, null, 1) + '\n');
  return { digest: sha256(manifest), manifest, templates, entries };
}

/** The single seed below `root`, read as files. */
function readSeed(root) {
  const dir = path.join(root, PI_JITI_SEED_DIR);
  const digests = existsSync(dir) ? readdirSync(dir) : [];
  assert.equal(digests.length, 1, `${dir} must hold exactly one seed`);
  const seedDir = path.join(dir, digests[0]);
  const files = new Map(readdirSync(seedDir, { recursive: true }).filter(file => !file.endsWith('templates'))
    .map(file => [file.split(path.sep).join('/'), sha256(readFileSync(path.join(seedDir, file)))]));
  return { digest: digests[0], files };
}

async function build() {
  const subagents = installed(client, 'pi-subagents');
  const jiti = installed(subagents.dir, 'jiti');
  // Pi's embedded loader and the seed must agree on jiti's cache format.
  assert.equal(installed(installed(client, '@earendil-works/pi-coding-agent').dir, 'jiti').manifest.version, jiti.manifest.version);
  const seed = await generate(subagents.dir, jiti.dir, path.join(client, 'dist/bin'));
  const seedDir = path.join(client, 'dist/assets', PI_JITI_SEED_DIR);
  await rm(seedDir, { recursive: true, force: true });
  await mkdir(path.join(seedDir, seed.digest, 'templates'), { recursive: true });
  await writeFile(path.join(seedDir, seed.digest, 'manifest.json'), seed.manifest);
  for (const [file, code] of seed.templates) await writeFile(path.join(seedDir, seed.digest, file), code);
  const bytes = [...seed.templates.values()].reduce((sum, code) => sum + Buffer.byteLength(code), seed.manifest.length);
  const groups = Object.entries(Object.groupBy(seed.entries, entry => entry.group)).map(([group, rows]) => `${group} ${rows.length}`).join(', ');
  console.log(`Pi jiti seed ${seed.digest.slice(0, 12)}: ${seed.entries.length} templates (${groups}), ${bytes} bytes`);
}

async function verifyInstalled(installRoot) {
  const root = realpathSync(installRoot);
  const clientPkg = installed(root, '@byok-sdk/client');
  const shipped = readSeed(path.join(clientPkg.dir, 'dist/assets'));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-pi-seed-gate-'));
  try {
    // The asset root a product builds from this install, run as one fresh execution.
    const { copyPiRuntimeAssets } = await import(pathToFileURL(path.join(clientPkg.dir, 'dist/index.js')).href);
    const assetRoot = path.join(scratch, 'pi');
    await copyPiRuntimeAssets({ outDir: assetRoot, form: 'compiled-executable' });
    // The materializer the packed client ships: its Bun runner seam, where the tarball's bundle put it.
    const result = zeroTransformRun(assetRoot, path.join(scratch, 'execution'), path.join(clientPkg.dir, 'dist/bin/pi-runtime-host.js'));
    assert.deepEqual(readSeed(assetRoot), shipped, 'copyPiRuntimeAssets changed the seed');
    // The seed is the one these installed inputs derive, under their locked integrities.
    const subagents = installed(clientPkg.dir, 'pi-subagents');
    const jiti = installed(subagents.dir, 'jiti');
    const expected = await generate(subagents.dir, jiti.dir, path.join(clientPkg.dir, 'dist/bin'));
    assert.equal(shipped.digest, expected.digest, 'the packed seed is not the seed of the installed pi-subagents and jiti');
    const expectedFiles = new Map([['manifest.json', sha256(expected.manifest)], ...[...expected.templates].map(([file, code]) => [file, sha256(code)])]);
    assert.deepEqual(shipped.files, expectedFiles, 'packed seed files differ from their manifest');
    const recorded = JSON.parse(readFileSync(path.join(clientPkg.dir, 'dist/assets', PI_JITI_SEED_DIR, shipped.digest, 'manifest.json'), 'utf8'));
    assert.equal(recorded.piClosureDigest, OFFICIAL_PI_PROVENANCE.closureDigest, 'seed is not bound to the official Pi closure');
    // npm verified each tarball against this integrity when it installed it.
    const npmLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    for (const pkg of [subagents, jiti]) {
      assert.equal(npmLock.packages?.[path.relative(root, pkg.dir).split(path.sep).join('/')]?.integrity, recorded.integrity[pkg.manifest.name],
        `installed ${pkg.manifest.name} integrity differs from the seed's locked integrity`);
    }
    console.log(`[release-pack] Pi jiti seed ${shipped.digest.slice(0, 12)}: ${result.entries} lookups after materializing, ${result.transforms} transforms; `
      + `packed seed equals the installed pi-subagents/jiti derivation, bound to bun.lock and Pi closure ${OFFICIAL_PI_PROVENANCE.closureDigest.slice(0, 12)}, copied unchanged`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One fresh execution: its own TMPDIR and cwd, no inherited jiti options. */
function zeroTransformRun(assetRoot, executionDir, materializer) {
  const tmp = path.join(executionDir, 'runtime'), cwd = path.join(executionDir, 'workspace');
  for (const dir of [tmp, cwd]) mkdirSync(dir, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('JITI_')));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--zero-transform', assetRoot, materializer],
    { cwd, env: { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`Pi jiti seed zero-transform gate could not run:\n${child.stderr}`);
  const result = JSON.parse(child.stdout);
  if (result.transforms !== 0) {
    throw new Error(`Pi jiti seed zero-transform gate failed: ${result.transforms} of ${result.entries} lookups transformed${result.unavailable ? ` (${result.unavailable})` : ''}`);
  }
  return result;
}

async function zeroTransform(assetRoot, materializer) {
  const { usePiJitiSeed } = await import(pathToFileURL(materializer).href);
  const pkg = path.join(assetRoot, 'pi-subagents');
  const { HOST_PEER_ALIASES } = await import(pathToFileURL(path.join(pkg, 'src/runs/background/runner-aliases.js')).href);
  const peers = mkdtempSync(path.join(os.tmpdir(), 'peers-'));
  writeFileSync(path.join(peers, 'host-peers.ts'), piSubagentHostPeersSource(HOST_PEER_ALIASES.filter(alias => !alias.optional).map(alias => alias.specifier)));
  let unavailable;
  // The loader below is created beside the materializer, as Pi's is beside its bundle.
  const seed = usePiJitiSeed(assetRoot, [pathToFileURL(materializer).href], reason => { unavailable = `pi_jiti_seed_unavailable: ${reason}`; });
  // This gate's oracle generates the bridge from its pinned Pi, independently
  // of the materializer (which the negative control deliberately replaces).
  const pi = await import('@earendil-works/pi-coding-agent');
  const hostSdk = mkdtempSync(path.join(os.tmpdir(), 'host-sdk-'));
  writeFileSync(path.join(hostSdk, 'index.js'), piSubagentHostSdkSource(pi));
  seed.materialize('parent', pkg, hostSdk); seed.materialize('runner', pkg); seed.materialize('host-peers', peers);
  // Derive the lookups from copied sources, independently of the manifest.
  const jitiDir = path.join(pkg, 'node_modules', 'jiti');
  const { createJiti } = createRequire(path.join(jitiDir, 'package.json'))(path.join(jitiDir, 'lib', 'jiti.cjs'));
  const lookups = await seedInputs(pkg, path.join(assetRoot, 'pi-subagent-extensions'), readFileSync(path.join(hostSdk, 'index.js'), 'utf8'), createJiti);
  let transforms = 0;
  // jiti's own cache choice, after the seed decided JITI_FS_CACHE: a cold seed leaves no cache to hit.
  const jiti = createJiti(materializer, {
    moduleCache: false, transform: () => { transforms++; return { code: '' }; },
  });
  for (const entry of lookups) {
    const filename = piJitiFilename(jiti, piJitiSeedFile(entry, entry.group === 'host-peers' ? peers : pkg, hostSdk));
    jiti.transform({ filename, source: readFileSync(filename, 'utf8'), ts: entry.ts, async: entry.async, jsx: false });
  }
  process.stdout.write(JSON.stringify({ entries: lookups.length, transforms, ...(unavailable === undefined ? {} : { unavailable }) }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target] = process.argv.slice(2);
  if (mode === undefined) await build();
  else if (mode === '--verify-installed' && target) await verifyInstalled(target);
  else if (mode === '--gate' && target) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-pi-seed-gate-'));
    const materializer = process.argv[4] === undefined ? SOURCE_MATERIALIZER : path.resolve(process.argv[4]);
    try { console.log(JSON.stringify(zeroTransformRun(path.resolve(target), scratch, materializer))); } finally { rmSync(scratch, { recursive: true, force: true }); }
  } else if (mode === '--zero-transform' && target && process.argv[4]) await zeroTransform(target, process.argv[4]);
  else throw new Error('usage: build-pi-jiti-seed.mjs [--verify-installed <installRoot> | --gate <piAssetRoot> [<materializerModule>]]');
}
