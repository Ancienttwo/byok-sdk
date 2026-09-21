#!/usr/bin/env node
// The isolated measurement half of the prepared-compile purity gate.
//
// Why a child process at all: the surfaces the fork's compile graph can touch
// are bound as ESM NAMED imports (`dist/config.js` opens with
// `import { accessSync, existsSync, readFileSync, realpathSync } from "fs"`),
// and a named binding resolves through the builtin module's ESM namespace. A
// monkeypatch applied to the CJS module object AFTER that namespace exists is
// invisible to it, which is exactly the hole the in-process trap test had. So
// the monitors go on FIRST, `module.syncBuiltinESMExports()` republishes them
// into the builtin namespaces, and only then is the fork imported — every
// named binding the fork takes is a binding to a monitored function.
//
// Monitors RECORD rather than throw, so one run reports every touch instead of
// stopping at the first. The two network-egress surfaces (`fetch`,
// `WebSocket`) are the exception: they record and then refuse, because calling
// through would be a real request.
//
// argv: <config-json-path>
// output: the JSON report at the config's `reportPath`. A file rather than
// stdout, because the report is written with the pristine `writeFileSync`
// captured before the monitors exist and so leaves no trace in its own
// measurement, and because the fork's own graph may write to stdout.

import module from 'node:module';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// Read the run configuration with the PRISTINE builtins, before anything is
// monitored: the probe's own setup must not appear in its own report.
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const writeReport = fs.writeFileSync;

/**
 * The installed fork root, resolved before the monitors exist, for origin
 * attribution. Both spellings are kept: the alias in `packages/client` is a
 * symlink, and Node reports stack frames at the real path it resolved to.
 */
const forkLinkRoot = fileURLToPath(
  new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url),
);
const forkRoots = [forkLinkRoot, `${fs.realpathSync(forkLinkRoot)}/`];

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The phase every event is stamped with. `setup`/`report` are never asserted on. */
let phase = 'setup';

/**
 * Distinct observations, each with the number of times it happened.
 *
 * Deduplicated because the load phase is dominated by the ESM loader reading
 * module sources through the public `fs` API — thousands of calls, a few
 * hundred distinct facts. Nothing is dropped: two calls collapse only when
 * their phase, API, argument and origin are all identical.
 */
const events = new Map();
const envReads = new Map();
const envWrites = new Map();

function tally(table, key, entry) {
  const existing = table.get(key);
  if (existing === undefined) table.set(key, { ...entry, count: 1 });
  else existing.count += 1;
}

/**
 * Where the call came from: the first stack frame that is neither this probe
 * nor a Node internal, shortened to a package-relative path so the report is
 * stable across checkouts.
 */
function originOf() {
  const stack = new Error().stack?.split('\n').slice(1) ?? [];
  for (const line of stack) {
    // Every `node:` frame is the runtime's own: the ESM loader reads module
    // sources through the PUBLIC `fs` API, so without this the loader's own
    // traffic would be attributed to whatever it happened to be loading.
    if (/\(node:[a-z_]/u.test(line) || /\sat\s+node:[a-z_]/u.test(line)) continue;
    if (line.includes(SELF)) continue;
    return shorten(line.trim().replace(/^at\s+/u, ''));
  }
  return '(runtime-internal)';
}

function shorten(frame) {
  for (const root of forkRoots) {
    const forkIndex = frame.indexOf(root);
    if (forkIndex >= 0) return `fork:${frame.slice(forkIndex + root.length).replace(/\)$/u, '')}`;
  }
  const moduleIndex = frame.lastIndexOf('/node_modules/');
  if (moduleIndex >= 0) return `dep:${frame.slice(moduleIndex + '/node_modules/'.length).replace(/\)$/u, '')}`;
  return frame;
}

/** `fork` is the only class the gate asserts on; the rest are reported, not claimed. */
function classOf(origin) {
  if (origin.startsWith('fork:')) return 'fork';
  if (origin.startsWith('dep:')) return 'dependency';
  if (origin === '(runtime-internal)') return 'runtime';
  return 'other';
}

/** First argument only, stringified and bounded: enough to name a path, never a payload. */
function describe(args) {
  const first = args[0];
  if (typeof first === 'string') return first.slice(0, 200);
  if (first instanceof URL) return first.href.slice(0, 200);
  if (Buffer.isBuffer(first)) return `<buffer ${first.byteLength}>`;
  if (typeof first === 'number') return `<fd ${first}>`;
  if (first && typeof first === 'object') {
    const port = Reflect.get(first, 'port');
    const host = Reflect.get(first, 'host') ?? Reflect.get(first, 'hostname');
    if (port !== undefined || host !== undefined) return `${String(host)}:${String(port)}`;
  }
  return `<${typeof first}>`;
}

function record(kind, api, detail) {
  const origin = originOf();
  tally(events, `${phase}|${kind}|${api}|${detail}|${origin}`, {
    phase,
    kind,
    api,
    detail,
    origin,
    source: classOf(origin),
  });
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

/**
 * Wrap one method with a Proxy rather than a plain function.
 *
 * A Proxy forwards `get`, so `fs.realpathSync.native` and every other property
 * hanging off a builtin stays reachable, and it traps `construct`, so
 * `new Worker(...)` and `new net.Socket(...)` are seen too. A hand-written
 * wrapper function silently drops both.
 */
function watch(target, key, kind, api, { callThrough = true } = {}) {
  if (target === undefined || target === null) return;
  const original = Reflect.get(target, key);
  if (typeof original !== 'function') return;
  const proxy = new Proxy(original, {
    apply(fn, self, args) {
      record(kind, api, describe(args));
      if (!callThrough) throw new Error(`purity monitor refused ${api}: this probe performs no network I/O`);
      return Reflect.apply(fn, self, args);
    },
    construct(fn, args, newTarget) {
      record(kind, api, describe(args));
      if (!callThrough) throw new Error(`purity monitor refused new ${api}: this probe performs no network I/O`);
      return Reflect.construct(fn, args, newTarget);
    },
  });
  try {
    Reflect.set(target, key, proxy);
  } catch {
    /* a non-writable builtin property is reported by its absence from the list below */
  }
}

/**
 * The filesystem families, enumerated rather than sampled: for each name the
 * callback form, the `...Sync` form and the `fs.promises` form. Anything the
 * fork could use to read a home directory, a config file or a credential is in
 * here by construction rather than by having been thought of.
 */
const FS_FAMILIES = [
  'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'exists', 'glob', 'lchmod', 'lchown',
  'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'read', 'readdir', 'readFile',
  'readlink', 'readv', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate',
  'unlink', 'utimes', 'write', 'writeFile', 'writev',
];

/** Everything on `fs` outside the families above that still reaches the disk. */
const FS_EXTRA = [
  'close', 'closeSync', 'createReadStream', 'createWriteStream', 'fchmod', 'fchmodSync', 'fchown',
  'fchownSync', 'fdatasync', 'fdatasyncSync', 'fstat', 'fstatSync', 'fsync', 'fsyncSync',
  'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync', 'openAsBlob', 'unwatchFile', 'watch',
  'watchFile',
];

function installFilesystemMonitors() {
  for (const name of FS_FAMILIES) {
    // `realpath.native` / `realpathSync.native` are separate functions hanging
    // off the outer one; wrap them BEFORE the outer proxy so the proxy's `get`
    // hands out the monitored version.
    for (const outer of [name, `${name}Sync`]) {
      const fn = Reflect.get(fs, outer);
      if (typeof fn === 'function' && typeof Reflect.get(fn, 'native') === 'function') {
        watch(fn, 'native', 'fs', `fs.${outer}.native`);
      }
    }
    watch(fs, name, 'fs', `fs.${name}`);
    watch(fs, `${name}Sync`, 'fs', `fs.${name}Sync`);
    watch(fs.promises, name, 'fs', `fs.promises.${name}`);
  }
  for (const name of FS_EXTRA) watch(fs, name, 'fs', `fs.${name}`);
}

function installCapabilityMonitors() {
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    watch(childProcess, name, 'process', `child_process.${name}`);
  }
  for (const name of ['connect', 'createConnection', 'createServer', 'Socket', 'Server']) {
    watch(net, name, 'network', `net.${name}`);
  }
  for (const [namespace, label] of [[http, 'http'], [https, 'https']]) {
    for (const name of ['request', 'get', 'createServer']) watch(namespace, name, 'network', `${label}.${name}`);
  }
  for (const name of ['connect', 'createServer', 'createSecureServer']) {
    watch(http2, name, 'network', `http2.${name}`);
  }
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt', 'resolveSrv']) {
    watch(dns, name, 'network', `dns.${name}`);
    watch(dns.promises, name, 'network', `dns.promises.${name}`);
  }
  for (const name of ['connect', 'createServer', 'createSecureContext']) watch(tls, name, 'network', `tls.${name}`);
  watch(dgram, 'createSocket', 'network', 'dgram.createSocket');
  watch(workerThreads, 'Worker', 'process', 'worker_threads.Worker');
  watch(os, 'homedir', 'ambient', 'os.homedir');
  watch(os, 'userInfo', 'ambient', 'os.userInfo');
  watch(process, 'cwd', 'ambient', 'process.cwd');
  watch(process, 'chdir', 'ambient', 'process.chdir');
  // The two egress surfaces that have no harmless call-through.
  watch(globalThis, 'fetch', 'network', 'globalThis.fetch', { callThrough: false });
  watch(globalThis, 'WebSocket', 'network', 'globalThis.WebSocket', { callThrough: false });
}

/**
 * `process.env` becomes a recording Proxy.
 *
 * The check it replaces compared `JSON.stringify(process.env)` before and
 * after, which can only ever detect a WRITE. What matters for a determinism
 * gate is the READ: `dist/config.js` reads `PI_PACKAGE_DIR` and
 * `PI_CODING_AGENT_DIR`, and an ambient value that reaches D is a byte nobody
 * counted.
 */
function recordEnvRead(key, via) {
  const origin = originOf();
  tally(envReads, `${phase}|${key}|${via}|${origin}`, { phase, key, via, origin, source: classOf(origin) });
}

function recordEnvWrite(key, via) {
  const origin = originOf();
  tally(envWrites, `${phase}|${key}|${via}|${origin}`, { phase, key, via, origin, source: classOf(origin) });
}

function installEnvironmentMonitor() {
  const real = process.env;
  const proxy = new Proxy(real, {
    get(target, key, receiver) {
      if (typeof key === 'string') recordEnvRead(key, 'get');
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') recordEnvRead(key, 'in');
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      recordEnvRead('*', 'ownKeys');
      return Reflect.ownKeys(target);
    },
    set(target, key, value, receiver) {
      recordEnvWrite(String(key), 'set');
      return Reflect.set(target, key, value, receiver);
    },
    deleteProperty(target, key) {
      recordEnvWrite(String(key), 'delete');
      return Reflect.deleteProperty(target, key);
    },
  });
  Object.defineProperty(process, 'env', { value: proxy, writable: true, enumerable: true, configurable: true });
}

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

/**
 * Rewrite a module the compile REALLY executes, in memory only.
 *
 * `dist/core/system-prompt.js` is on the path by construction —
 * `dist/core/input-preparation.js` calls `buildSystemPrompt(copied.prompt)` —
 * and the control firing during `compileCold` is what proves it rather than
 * the claim. The injected read uses a NAMED `node:fs` import on purpose: that
 * is the exact binding shape the old in-process trap could not see.
 *
 * Nothing on disk is touched; `registerHooks` hands back a source string.
 */
function installNegativeControl(mode) {
  const canaryFile = JSON.stringify(config.canaryFile);
  const canaryEnvKey = JSON.stringify(config.canaryEnvKey);
  const bodies = {
    'control-fs': `try { globalThis.__piPurityControlFs = __ctrlReadFileSync(${canaryFile}, "utf8"); } catch (error) { globalThis.__piPurityControlFs = String(error); }`,
    'control-env': `try { globalThis.__piPurityControlEnv = process.env[${canaryEnvKey}]; } catch (error) { globalThis.__piPurityControlEnv = String(error); }`,
    // Both capability shapes, each guarded so an absent monitor still does
    // nothing real: an empty `-e` program exits immediately, and port 1 on
    // loopback refuses the connection before any bytes move.
    'control-capability': `try { __ctrlSpawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }); } catch {}
  try { const socket = __ctrlConnect({ host: "127.0.0.1", port: 1 }); socket.on("error", () => {}); socket.unref(); socket.destroy(); } catch {}`,
  };
  const body = bodies[mode];
  if (body === undefined) throw new Error(`unknown control mode ${mode}`);

  const prelude = [
    'import { readFileSync as __ctrlReadFileSync } from "node:fs";',
    'import { spawnSync as __ctrlSpawnSync } from "node:child_process";',
    'import { connect as __ctrlConnect } from "node:net";',
    '',
  ].join('\n');
  const anchor = 'export function buildSystemPrompt(input) {';

  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith('/dist/core/system-prompt.js')) return result;
      const source = String(result.source);
      if (!source.includes(anchor)) throw new Error('negative control anchor not found in system-prompt.js');
      return { ...result, source: `${prelude}${source.replace(anchor, `${anchor}\n  ${body}\n`)}` };
    },
  });
}

// ---------------------------------------------------------------------------
// The compile input: the same shape `adapters/pi/input-preparation.ts` builds
// ---------------------------------------------------------------------------

/**
 * The prompt surface of `pi-input-preparation.test.ts`'s own fixture, mapped
 * onto the fork's parameter names exactly as the adapter maps them — the same
 * non-empty `toolGuidelines`, `skills`, `contextFiles` and host-canonical
 * prefix, and the same `constrainedSampling` on both tools.
 *
 * Stated here rather than imported because this file runs as plain Node, with
 * no TypeScript loader and no vitest module graph. The parent test pins the
 * two fixtures against each other so they cannot drift apart silently.
 */
function nativeCompileInput(preparedToolProjection) {
  return {
    snapshot: {
      prompt: {
        cwd: '/workspace/project',
        selectedTools: ['read', 'bash'],
        toolSnippets: { read: 'read snippet', bash: 'bash snippet' },
        toolGuidelines: { read: ['read before you write'], bash: ['quote every path'] },
        promptGuidelines: ['prefer small diffs'],
        contextFiles: [{ path: 'AGENTS.md', content: '# agents\nbe precise\n' }],
        skills: [
          {
            name: 'review',
            description: 'review a diff before it is proposed',
            filePath: '/workspace/project/.skills/review/SKILL.md',
            disableModelInvocation: false,
          },
        ],
        docsPaths: { readme: 'README.md', docs: 'docs', examples: 'examples' },
      },
      messages: [
        { role: 'user', content: 'what does this repository do?', timestamp: 1_699_999_999_000 },
        {
          role: 'assistant',
          origin: 'host_canonical',
          content: [{ type: 'text', text: 'It is a BYOK SDK.' }],
          timestamp: 1_699_999_999_500,
        },
        { role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 },
      ],
      tools: [
        {
          name: 'read',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          constrainedSampling: { type: 'json_schema', strict: 'prefer' },
        },
        {
          name: 'bash',
          description: 'run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          constrainedSampling: { type: 'json_schema', strict: 'prefer' },
        },
      ].map((tool) => preparedToolProjection(tool)),
    },
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
    options: { cacheRetention: 'none', maxTokens: 4_096, temperature: 0 },
    binding: {
      inputIdentity: 'rev-1:src-1',
      runtimeIdentity: 'runtime-1',
      policyIdentity: 'policy-1',
      profileRevision: 'profile-1',
    },
    toolExecutors: { read: 'exec:read@1', bash: 'exec:bash@1' },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Order is the whole point: monitors, then republish into the builtin ESM
// namespaces, then — and only then — the fork's module graph.
installFilesystemMonitors();
installCapabilityMonitors();
installEnvironmentMonitor();
module.syncBuiltinESMExports();

if (config.mode !== 'clean') installNegativeControl(config.mode);

const report = { mode: config.mode, node: process.version, failure: null };

try {
  phase = 'load';
  // The same specifier `adapters/pi/input-preparation.ts` imports, resolved the
  // same way: a bare fork subpath from inside `packages/client`.
  const native = await import('@earendil-works/pi-coding-agent/prepared-session-input');
  const input = nativeCompileInput(native.preparedToolProjection);

  phase = 'compileCold';
  const cold = await native.prepareCodingAgentSessionInput(input);

  phase = 'compileWarm';
  const warm = await native.prepareCodingAgentSessionInput(input);

  phase = 'report';
  report.requestBody = cold.providerRequest.body;
  report.warmRequestBody = warm.providerRequest.body;
  report.envelopeDigest = cold.digest;
} catch (error) {
  phase = 'report';
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const inPhase = (table, name) => [...table.values()].filter((entry) => entry.phase === name);

for (const name of ['load', 'compileCold', 'compileWarm']) {
  report[name] = {
    events: inPhase(events, name),
    envReads: inPhase(envReads, name),
    envWrites: inPhase(envWrites, name),
  };
}
report.setupEnvWrites = inPhase(envWrites, 'setup');
report.control = {
  fs: globalThis.__piPurityControlFs ?? null,
  env: globalThis.__piPurityControlEnv ?? null,
};

writeReport(config.reportPath, JSON.stringify(report), 'utf8');
process.exit(0);
