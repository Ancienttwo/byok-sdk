import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The packaging-time jiti seed of the embedded pi-subagents extension (#1927).
 * The build transforms the supported extension graph once with the pinned
 * jiti; each Execution materializes private cache files from these
 * templates, so no task runs Babel for that graph. A seed is a cache of a
 * transform of trusted bytes: one that does not verify is discarded and Pi
 * transforms cold, as before.
 */
export const PI_JITI_SEED_DIR = 'sdk-derived/pi-jiti-seed';
export const PI_JITI_SEED_FORMAT = 'byok.pi.jiti-seed';
export const PI_JITI_SEED_VERSION = 1;
/** Templates are generated against this root; only their own file URL literal names it. */
export const PI_JITI_SEED_CANONICAL_ROOT = '/__byok_pi_jiti_seed__';
/** Roots a manifest entry is relative to: the copied extension package, and the generated peer probe. */
export const PI_JITI_SEED_BASES = Object.freeze(['pi-subagents', 'host-peers']);

export const PI_SUBAGENTS_PEERS_KEY = 'byok-sdk.pi-subagents.peers';
export const PI_SUBAGENTS_HOST_KEY = 'byok-sdk.pi-subagents.host-sdk';
const HOST_PEER = '@earendil-works/pi-coding-agent';

/** The generated peer probe a Bun-compiled product loads through Pi's loader. */
export function piSubagentHostPeersSource(specifiers) {
  return [
    ...specifiers.map((specifier, index) => `import * as peer${index} from ${JSON.stringify(specifier)};`),
    `const peers = { ${specifiers.map((specifier, index) => `${JSON.stringify(specifier)}: peer${index}`).join(', ')} };`,
    `globalThis[Symbol.for(${JSON.stringify(PI_SUBAGENTS_PEERS_KEY)})] = peers;`,
    `globalThis[Symbol.for(${JSON.stringify(PI_SUBAGENTS_HOST_KEY)})] = peers[${JSON.stringify(HOST_PEER)}];`,
    'export default function captureHostPeers() {}',
  ].join('\n');
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The JavaScript literal jiti's transform writes for `import.meta.url` of `file`. */
export function fileUrlLiteral(file) {
  return JSON.stringify(pathToFileURL(file).href);
}

export function canonicalSeedFile(base, relative) {
  return path.posix.join(PI_JITI_SEED_CANONICAL_ROOT, base, relative);
}

const refuse = reason => { throw new Error(`pi_jiti_seed_unavailable: ${reason}`); };

/**
 * The cache directory the Pi loader's jiti will use, chosen as jiti 2.7.0
 * chooses its default, or a refusal when that directory is not this
 * execution's own: an adjacent `node_modules/.cache/jiti` would be shared,
 * and environment overrides change the cache contract.
 */
function executionCacheDir(loaderUrl) {
  for (const name of ['JITI_FS_CACHE', 'JITI_REBUILD_FS_CACHE', 'JITI_SOURCE_MAPS', 'JITI_CACHE', 'JITI_JSX']) {
    if (process.env[name] !== undefined) refuse(`${name} changes the jiti cache contract`);
  }
  const loader = typeof loaderUrl === 'string' && loaderUrl.startsWith('file:') ? fileURLToPath(loaderUrl) : loaderUrl;
  if (typeof loader === 'string' && existsSync(path.resolve(loader, '../node_modules'))) refuse('the Pi loader would use an adjacent shared cache');
  const tmp = os.tmpdir();
  if (process.env.TMPDIR && tmp === process.cwd() && !process.env.JITI_RESPECT_TMPDIR_ENV) refuse('TMPDIR is the working directory');
  return path.join(tmp, 'jiti');
}

/**
 * Open the one seed below `seedRoot` and bind it to this execution's cache.
 * `loaderUrl` is the `import.meta.url` Pi's extension loader runs under in
 * this bundle. Throws `pi_jiti_seed_unavailable` when the seed cannot be
 * used; the caller reports that and continues cold.
 */
export function openPiJitiSeed(seedRoot, loaderUrl) {
  const dir = path.join(seedRoot, PI_JITI_SEED_DIR);
  const digests = existsSync(dir) ? readdirSync(dir) : [];
  if (digests.length !== 1) refuse(`expected one seed in ${dir}, found ${digests.length}`);
  const bytes = readFileSync(path.join(dir, digests[0], 'manifest.json'));
  if (sha256(bytes) !== digests[0]) refuse('manifest digest mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== PI_JITI_SEED_FORMAT || manifest.version !== PI_JITI_SEED_VERSION) refuse('unsupported manifest');
  const pkg = path.join(seedRoot, 'pi-subagents');
  const installed = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  if (`${installed.name}@${installed.version}` !== manifest.piSubagents) refuse(`seed is for ${manifest.piSubagents}, not ${installed.name}@${installed.version}`);
  // The asset root's own flat copy; a compiled Bun product cannot resolve packages from disk.
  const jitiDir = path.join(pkg, 'node_modules', 'jiti');
  const jitiVersion = JSON.parse(readFileSync(path.join(jitiDir, 'package.json'), 'utf8')).version;
  if (jitiVersion !== manifest.jiti) refuse(`seed is for jiti ${manifest.jiti}, not ${jitiVersion}`);
  const cacheDir = executionCacheDir(loaderUrl);
  if (existsSync(cacheDir) && readdirSync(cacheDir).length > 0) refuse(`${cacheDir} is not a fresh execution cache`);
  let body;
  const jiti = createRequire(path.join(jitiDir, 'package.json'))(path.join(jitiDir, 'lib', 'jiti.cjs')).createJiti(path.join(cacheDir, 'seed.cjs'), {
    fsCache: cacheDir, moduleCache: false,
    // Only verified templates reach jiti; it names and footers the cache files itself.
    transform: () => ({ code: body }),
  });
  const templates = path.join(dir, digests[0]);
  return {
    digest: digests[0], cacheDir,
    /** Write the private cache files of every `base` entry; `root` is that base's directory. */
    materialize(base, root) {
      const prepared = manifest.entries.filter(entry => entry.base === base).map(entry => {
        const file = realpathSync(path.join(root, entry.path));
        const source = readFileSync(file, 'utf8');
        if (sha256(source) !== entry.sourceSha256) refuse(`source changed: ${base}/${entry.path}`);
        let code = readFileSync(path.join(templates, entry.template), 'utf8');
        if (sha256(code) !== entry.templateSha256) refuse(`template changed: ${entry.template}`);
        const canonical = fileUrlLiteral(canonicalSeedFile(base, entry.path)), actual = fileUrlLiteral(file);
        for (const site of [...entry.sites].sort((a, b) => b - a)) {
          if (code.slice(site, site + canonical.length) !== canonical) refuse(`relocation site mismatch: ${entry.template}@${site}`);
          code = code.slice(0, site) + actual + code.slice(site + canonical.length);
        }
        return { file, source, code, entry };
      });
      if (prepared.length === 0) refuse(`no seed entries for ${base}`);
      const before = existsSync(cacheDir) ? readdirSync(cacheDir).length : 0;
      for (const { file, source, code, entry } of prepared) {
        body = code;
        jiti.transform({ filename: file, source, ts: entry.ts, async: entry.async, jsx: false });
      }
      body = undefined;
      const written = readdirSync(cacheDir).length - before;
      if (written !== prepared.length) refuse(`wrote ${written} of ${prepared.length} cache files for ${base}`);
      return written;
    },
  };
}
