import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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
/**
 * Seed groups. `parent`: the parent extension's bundle graph, loaded by every
 * bundled Pi host. `runner`: the Bun background runner's graph, materialized
 * only when a compiled product re-enters as that runner. `host-peers`: the
 * generated peer probe of a Bun-compiled product. The first two are relative
 * to the copied pi-subagents package, the last to the probe's directory.
 */
export const PI_JITI_SEED_GROUPS = Object.freeze(['parent', 'runner', 'host-peers']);

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

export function canonicalSeedFile(group, relative) {
  return path.posix.join(PI_JITI_SEED_CANONICAL_ROOT, group === 'host-peers' ? 'host-peers' : 'pi-subagents', relative);
}

/**
 * A refusal the seed constructs itself. Its reason names files and versions
 * only; it is the one text that reaches the Host diagnostic.
 */
class PiJitiSeedRefusal extends Error {
  constructor(reason) {
    super(`pi_jiti_seed_unavailable: ${reason}`);
    this.reason = reason.replace(/[\r\n]+/gu, ' ');
  }
}
const refuse = reason => { throw new PiJitiSeedRefusal(reason); };

/**
 * The diagnostic reason of a seed failure. Any other exception (JSON, I/O, a
 * module that throws) may quote bytes it read, so only its class is kept.
 */
function refusalReason(error) {
  if (error instanceof PiJitiSeedRefusal) return error.reason;
  return `the seed could not be read (${error instanceof Error ? error.constructor.name : typeof error})`;
}

/**
 * The cache directory every listed jiti loader will use, chosen as jiti 2.7.0
 * chooses its default, or a refusal when that directory is not this
 * execution's own: an adjacent `node_modules/.cache/jiti` would be shared,
 * and environment overrides change the cache contract.
 */
function executionCacheDir(loaderUrls) {
  for (const name of ['JITI_FS_CACHE', 'JITI_REBUILD_FS_CACHE', 'JITI_SOURCE_MAPS', 'JITI_CACHE', 'JITI_JSX']) {
    if (process.env[name] !== undefined) refuse(`${name} changes the jiti cache contract`);
  }
  for (const loaderUrl of loaderUrls) {
    const loader = loaderUrl.startsWith('file:') ? fileURLToPath(loaderUrl) : loaderUrl;
    if (existsSync(path.resolve(loader, '../node_modules'))) refuse('the Pi loader would use an adjacent shared cache');
  }
  const tmp = os.tmpdir();
  if (process.env.TMPDIR && tmp === process.cwd() && !process.env.JITI_RESPECT_TMPDIR_ENV) refuse('TMPDIR is the working directory');
  return path.join(tmp, 'jiti');
}

/**
 * Open the one seed below `seedRoot` and bind it to this execution's cache.
 * `loaderUrls` are the filenames every jiti loader of this process's seeded
 * graphs is created with (Pi's extension loader runs under this bundle's
 * `import.meta.url`). Throws `pi_jiti_seed_unavailable` when the seed cannot
 * be used.
 */
export function openPiJitiSeed(seedRoot, loaderUrls) {
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
  const cacheDir = executionCacheDir(loaderUrls);
  try {
    mkdirSync(cacheDir, { recursive: true });
    accessSync(cacheDir, constants.W_OK);
  } catch {
    refuse(`${cacheDir} is not writable`);
  }
  let body;
  const jiti = createRequire(path.join(jitiDir, 'package.json'))(path.join(jitiDir, 'lib', 'jiti.cjs')).createJiti(path.join(cacheDir, 'seed.cjs'), {
    fsCache: cacheDir, moduleCache: false,
    // Only verified templates reach jiti; it names and footers the cache files itself.
    transform: () => { const code = body; body = undefined; return { code }; },
  });
  const templates = path.join(dir, digests[0]);
  return {
    digest: digests[0], cacheDir,
    /**
     * Write this execution's cache file for every `group` entry; `root` is the
     * group's directory. Every source, template and relocation site is checked
     * before anything is written. An entry jiti already finds in this
     * execution's cache, written earlier by the same execution, is kept.
     */
    materialize(group, root) {
      const prepared = manifest.entries.filter(entry => entry.group === group).map(entry => {
        const file = realpathSync(path.join(root, entry.path));
        const source = readFileSync(file, 'utf8');
        if (sha256(source) !== entry.sourceSha256) refuse(`source changed: ${file}`);
        let code = readFileSync(path.join(templates, entry.template), 'utf8');
        if (sha256(code) !== entry.templateSha256) refuse(`template changed: ${path.join(templates, entry.template)}`);
        const actual = fileUrlLiteral(file);
        // The literal the build platform wrote for the canonical file, so a seed built on one OS relocates on another.
        for (const site of [...entry.sites].sort((a, b) => b - a)) {
          if (code.slice(site, site + entry.siteLiteral.length) !== entry.siteLiteral) refuse(`relocation site mismatch: ${path.join(templates, entry.template)}`);
          code = code.slice(0, site) + actual + code.slice(site + entry.siteLiteral.length);
        }
        return { file, source, code, entry };
      });
      if (prepared.length === 0) refuse(`no seed entries for ${group}`);
      let written = 0;
      for (const { file, source, code, entry } of prepared) {
        body = code;
        jiti.transform({ filename: file, source, ts: entry.ts, async: entry.async, jsx: false });
        if (body === undefined) written++;
        body = undefined;
      }
      return { written, kept: prepared.length - written };
    },
  };
}

/**
 * The seed of one Pi process. jiti's fs cache stays on only while the seed
 * opened, which proves the cache directory is this execution's own, and every
 * materialization verified. Any failure, whatever its cause, sets
 * `JITI_FS_CACHE=false` for this process and the processes it starts, so
 * every later jiti loader transforms in memory; `report` receives the reason
 * once. Call this, and `materialize` each group, before the first jiti loader
 * of the process is created.
 */
export function usePiJitiSeed(seedRoot, loaderUrls, report) {
  let seed;
  const cold = error => {
    seed = undefined;
    process.env.JITI_FS_CACHE = 'false';
    report(refusalReason(error));
  };
  try { seed = openPiJitiSeed(seedRoot, loaderUrls); } catch (error) { cold(error); }
  return {
    materialize(group, root) {
      if (seed === undefined) return;
      try { seed.materialize(group, root); } catch (error) { cold(error); }
    },
  };
}
