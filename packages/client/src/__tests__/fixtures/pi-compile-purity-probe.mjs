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
import nodeCrypto from 'node:crypto';
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

/**
 * Clock and randomness, recorded in their OWN table.
 *
 * They are not purity violations: reading the clock reaches no file, no socket
 * and no ambient configuration. They are determinism risks, which is a
 * different claim needing a different assertion — an explicit per-origin
 * allowlist, plus the forced-skew pair the parent test compares byte for byte.
 * Keeping them out of `events` is what stops `purityViolations()` from
 * conflating the two.
 */
const nondeterminism = new Map();

/**
 * Monitor installation is itself measured.
 *
 * `monitorInstallFailures` holds every monitor that was INTENDED and could not
 * be installed (`Reflect.set` refused, or the readback did not come back as the
 * proxy). A non-empty list means the gate's coverage is smaller than the list
 * it claims, so the parent test asserts it is empty rather than leaving the
 * failure to be inferred from a monitor that never fires.
 *
 * `monitorsAbsent` holds every monitor that was intended and whose target does
 * not exist on THIS Node. That is a legitimate outcome — `fs.promises` has no
 * `exists`, the WebCrypto global has no `randomBytes` — but it is a fact about
 * the running runtime, so the parent test pins it against an explicit measured
 * list per Node major instead of letting a surface silently stop being watched.
 */
const monitorInstallFailures = [];
const monitorsAbsent = [];

/**
 * fd → path, for every fd a MONITORED open handed out.
 *
 * Without it an `fs.readSync(<fd 23>)` / `fs.closeSync(<fd 23>)` names no path,
 * and the load-phase assertion that every path read lies inside an installed
 * package silently skips it. With it, an fd resolves to the path it was opened
 * at and is covered by that assertion; an fd NOBODY monitored opened resolves
 * to `unknown-fd:<n>`, which lies outside every installed package by
 * construction and therefore fails the assertion instead of vanishing from it.
 */
const fdPaths = new Map();

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
    // A V8 builtin entered from user code has no script: `Object.keys` and
    // `Object.getOwnPropertyDescriptor` appear as `(<anonymous>)`. Attributing
    // an environment read to the builtin the caller went through would hide
    // the file that made it, so the frame is stepped over like a runtime one.
    if (/\(<anonymous>\)$/u.test(line.trim())) continue;
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

/** The path a monitored open was given, in the one shape `fdPaths` stores. */
function pathLabel(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (value instanceof URL) return value.href.slice(0, 200);
  if (Buffer.isBuffer(value)) return value.toString('utf8').slice(0, 200);
  return null;
}

/** Remember what a monitored open returned, so later fd-based calls name a path. */
function rememberFd(fd, pathArgument) {
  const known = pathLabel(pathArgument);
  if (typeof fd === 'number' && Number.isInteger(fd) && known !== null) fdPaths.set(fd, known);
}

/** First argument only, stringified and bounded: enough to name a path, never a payload. */
function describe(args, kind) {
  const first = args[0];
  if (typeof first === 'string') return first.slice(0, 200);
  if (first instanceof URL) return first.href.slice(0, 200);
  if (Buffer.isBuffer(first)) return `<buffer ${first.byteLength}>`;
  if (typeof first === 'number') {
    // An `fs` API taking a number takes an fd. Resolve it to the path the
    // monitored open handed it out for; an fd from an open this probe never
    // saw is named as such rather than reported as an anonymous `<fd n>`.
    if (kind !== 'fs') return `<number ${first}>`;
    const known = fdPaths.get(first);
    return known === undefined ? `unknown-fd:${first}` : `fd:${first}:${known}`;
  }
  if (first && typeof first === 'object') {
    const port = Reflect.get(first, 'port');
    const host = Reflect.get(first, 'host') ?? Reflect.get(first, 'hostname');
    if (port !== undefined || host !== undefined) return `${String(host)}:${String(port)}`;
  }
  return `<${typeof first}>`;
}

function recordNondeterminism(api) {
  const origin = originOf();
  tally(nondeterminism, `${phase}|${api}|${origin}`, { phase, api, origin, source: classOf(origin) });
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
function install(target, key, api, proxy) {
  // `Reflect.set` RETURNS false on a non-writable or setter-less property
  // rather than throwing, so the old empty `catch` could never have seen the
  // failure it was written for. Both shapes are recorded, and the readback
  // catches the third shape: a `set` that reports success and does not stick.
  const label = api.endsWith(`.${key}`) ? api.slice(0, -(key.length + 1)) : api;
  let accepted = false;
  let error = null;
  try {
    accepted = Reflect.set(target, key, proxy);
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  if (error === null && !accepted) error = 'Reflect.set returned false';
  if (error === null && Reflect.get(target, key) !== proxy) error = 'readback did not return the monitor';
  if (error !== null) monitorInstallFailures.push({ target: label, key: String(key), api, error });
}

/**
 * Whether a plain assignment can put a monitor here at all.
 *
 * A non-configurable getter-only property cannot be replaced or redefined by
 * anything, so attempting it would produce a failure the probe can never fix.
 * `node:crypto`'s `getRandomValues` is exactly that on Node 22 and 24. The
 * monitor is therefore reported as ABSENT on this runtime, with the same
 * standing as a builtin that does not exist, rather than as a probe bug.
 */
function monitorable(target, key) {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || descriptor.configurable) return true;
  if ('value' in descriptor) return descriptor.writable === true;
  return typeof descriptor.set === 'function';
}

function absent(key, api, reason) {
  const label = api.endsWith(`.${key}`) ? api.slice(0, -(key.length + 1)) : api;
  monitorsAbsent.push({ target: label, key: String(key), api, reason });
}

function watch(target, key, kind, api, { callThrough = true, before, after } = {}) {
  if (target === undefined || target === null) return absent(key, api, 'container-absent');
  const original = Reflect.get(target, key);
  if (typeof original !== 'function') {
    return absent(key, api, original === undefined ? 'absent' : `not-a-function:${typeof original}`);
  }
  if (!monitorable(target, key)) return absent(key, api, 'unwritable');
  const proxy = new Proxy(original, {
    apply(fn, self, args) {
      record(kind, api, describe(args, kind));
      if (!callThrough) throw new Error(`purity monitor refused ${api}: this probe performs no network I/O`);
      const forwarded = before === undefined ? args : before(args);
      const result = Reflect.apply(fn, self, forwarded);
      if (after !== undefined) after(args, result);
      return result;
    },
    construct(fn, args, newTarget) {
      record(kind, api, describe(args, kind));
      if (!callThrough) throw new Error(`purity monitor refused new ${api}: this probe performs no network I/O`);
      return Reflect.construct(fn, args, newTarget);
    },
  });
  install(target, key, api, proxy);
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

/**
 * The three ways an fd enters the process through a monitored API, each with
 * the hook that files it under the path it was opened at: the sync form
 * returns the fd, the callback form is handed it, and the promise form
 * resolves a `FileHandle` carrying it.
 */
const OPEN_HOOKS = {
  'fs.openSync': { after: (args, result) => rememberFd(result, args[0]) },
  'fs.open': {
    before(args) {
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback !== 'function') return args;
      const forwarded = args.slice();
      forwarded[last] = function wrapped(error, fd) {
        rememberFd(fd, args[0]);
        return Reflect.apply(callback, this, arguments);
      };
      return forwarded;
    },
  },
  'fs.promises.open': {
    after(args, result) {
      if (result === null || typeof result?.then !== 'function') return;
      // Observation only: the returned promise is what the caller gets back,
      // and this branch neither replaces it nor changes its settlement.
      result.then(
        (handle) => rememberFd(handle?.fd, args[0]),
        () => {},
      );
    },
  },
};

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
    for (const api of [`fs.${name}`, `fs.${name}Sync`, `fs.promises.${name}`]) {
      const target = api.startsWith('fs.promises.') ? fs.promises : fs;
      const key = api.slice(api.lastIndexOf('.') + 1);
      watch(target, key, 'fs', api, OPEN_HOOKS[api] ?? {});
    }
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
 * Two skews, chosen to be far apart in every dimension at once.
 *
 * `skewed-a` is 2001-09-09 with the lowest value every generator can produce;
 * `skewed-b` is 2033-05-18 with the highest. A compile that reads a clock or a
 * generator and lets the value reach D cannot produce the same bytes under
 * both, so byte equality between the two runs is a measurement rather than an
 * argument. Forcing happens ONLY in these modes: the clean and control runs
 * record and return the real value, so nothing the rest of the gate measures
 * is measured through a doctored runtime.
 */
const SKEWS = {
  a: {
    now: 1_000_000_000_000,
    random: 0,
    byte: 0x00,
    uuid: '00000000-0000-4000-8000-000000000000',
    performanceNow: 0,
    hrtime: [0, 0],
    hrtimeBigint: 0n,
  },
  b: {
    now: 2_000_000_000_000,
    random: 0.999_999_999_999_999_9,
    byte: 0xff,
    uuid: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    performanceNow: 987_654_321.5,
    hrtime: [987_654, 321_000_000],
    hrtimeBigint: 987_654_321_000_000n,
  },
};

const skew = config.skew === undefined || config.skew === null ? null : SKEWS[config.skew];
if (config.skew !== undefined && config.skew !== null && skew === undefined) {
  throw new Error(`unknown skew ${String(config.skew)}`);
}

/**
 * A clock or generator monitor. RECORD-ONLY unless a skew is configured: no
 * throw, no refusal, and the real return value forwarded unchanged, because
 * reading the clock is not a purity violation and treating it as one would
 * make the gate lie about the provider path that legitimately does it.
 */
function watchValue(target, key, api, force) {
  if (target === undefined || target === null) return absent(key, api, 'container-absent');
  const original = Reflect.get(target, key);
  if (typeof original !== 'function') {
    return absent(key, api, original === undefined ? 'absent' : `not-a-function:${typeof original}`);
  }
  if (!monitorable(target, key)) return absent(key, api, 'unwritable');
  const proxy = new Proxy(original, {
    apply(fn, self, args) {
      recordNondeterminism(api);
      if (skew !== null && force !== undefined) return force(args, skew);
      return Reflect.apply(fn, self, args);
    },
  });
  install(target, key, api, proxy);
}

function forcedRandomBytes(args, forced) {
  const size = typeof args[0] === 'number' ? args[0] : 0;
  const filled = Buffer.alloc(size, forced.byte);
  const callback = args[1];
  if (typeof callback === 'function') {
    queueMicrotask(() => callback(null, filled));
    return undefined;
  }
  return filled;
}

function forcedGetRandomValues(args, forced) {
  const view = args[0];
  if (ArrayBuffer.isView(view)) {
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(forced.byte);
  }
  return view;
}

function installNondeterminismMonitors() {
  const RealDate = globalThis.Date;
  // `Date.now` is monitored on the real constructor BEFORE the constructor
  // itself is replaced, so the replacement's forwarding `get` hands out the
  // monitored function rather than shadowing it.
  watchValue(RealDate, 'now', 'Date.now', (_args, forced) => forced.now);
  const dateProxy = new Proxy(RealDate, {
    construct(fn, args, newTarget) {
      // ONLY the zero-argument form is ambient: `new Date(ms)` is as
      // deterministic as the number it was handed.
      if (args.length > 0) return Reflect.construct(fn, args, newTarget);
      recordNondeterminism('new Date()');
      return Reflect.construct(fn, skew === null ? args : [skew.now], newTarget);
    },
  });
  install(globalThis, 'Date', 'globalThis.Date', dateProxy);

  watchValue(Math, 'random', 'Math.random', (_args, forced) => forced.random);
  watchValue(globalThis.performance, 'now', 'performance.now', (_args, forced) => forced.performanceNow);
  // `.bigint` first, for the same reason `Date.now` is: the outer proxy
  // forwards `get`, so wrapping the outer function first would hide it.
  watchValue(process.hrtime, 'bigint', 'process.hrtime.bigint', (_args, forced) => forced.hrtimeBigint);
  watchValue(process, 'hrtime', 'process.hrtime', (_args, forced) => forced.hrtime.slice());

  for (const [namespace, label] of [
    [nodeCrypto, 'crypto'],
    [globalThis.crypto, 'globalThis.crypto'],
  ]) {
    watchValue(namespace, 'randomUUID', `${label}.randomUUID`, (_args, forced) => forced.uuid);
    watchValue(namespace, 'randomBytes', `${label}.randomBytes`, forcedRandomBytes);
    watchValue(namespace, 'getRandomValues', `${label}.getRandomValues`, forcedGetRandomValues);
  }
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
    // `Object.getOwnPropertyDescriptor(process.env, K)` and everything built
    // on it (`Object.entries`, `structuredClone`, spread over the descriptor
    // path) return the VALUE, so without this trap a read could be made
    // through a shape the gate reported as clean.
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === 'string') recordEnvRead(key, 'gOPD');
      return Reflect.getOwnPropertyDescriptor(target, key);
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
    // Two read shapes, because the Proxy traps them separately: the plain
    // `get`, and the descriptor path that returns the value without one.
    'control-env': `try { globalThis.__piPurityControlEnv = process.env[${canaryEnvKey}]; } catch (error) { globalThis.__piPurityControlEnv = String(error); }
  try { globalThis.__piPurityControlEnvDescriptor = Object.getOwnPropertyDescriptor(process.env, ${canaryEnvKey})?.value ?? null; } catch (error) { globalThis.__piPurityControlEnvDescriptor = String(error); }`,
    // Both capability shapes, each guarded so an absent monitor still does
    // nothing real: an empty `-e` program exits immediately, and port 1 on
    // loopback refuses the connection before any bytes move.
    'control-capability': `try { __ctrlSpawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }); } catch {}
  try { const socket = __ctrlConnect({ host: "127.0.0.1", port: 1 }); socket.on("error", () => {}); socket.unref(); socket.destroy(); } catch {}`,
  };

  const prelude = [
    'import { readFileSync as __ctrlReadFileSync } from "node:fs";',
    'import { spawnSync as __ctrlSpawnSync } from "node:child_process";',
    'import { connect as __ctrlConnect } from "node:net";',
    '',
  ].join('\n');
  const anchor = 'export function buildSystemPrompt(input) {';

  // The fourth control is the only one whose effect has to reach D, so it is
  // the only one that cannot be a statement at the top of the body: it wraps
  // the renderer and puts the clock and the generator INTO the rendered
  // prompt text. Under the two skews that text differs, which is what makes
  // "D is byte-identical across skews" a falsifiable claim rather than a
  // property of a fixture that happens to read no clock.
  const replacement =
    mode === 'control-nondeterminism'
      ? `export function buildSystemPrompt(input) {
  return __ctrlRenderSystemPrompt(input) + "\\n<!-- purity-control " + String(Date.now()) + " " + String(Math.random()) + " -->";
}
function __ctrlRenderSystemPrompt(input) {`
      : (() => {
          const body = bodies[mode];
          if (body === undefined) throw new Error(`unknown control mode ${mode}`);
          return `${anchor}\n  ${body}\n`;
        })();

  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith('/dist/core/system-prompt.js')) return result;
      const source = String(result.source);
      if (!source.includes(anchor)) throw new Error('negative control anchor not found in system-prompt.js');
      return { ...result, source: `${prelude}${source.replace(anchor, replacement)}` };
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
installNondeterminismMonitors();
installEnvironmentMonitor();
module.syncBuiltinESMExports();

if (config.mode !== 'clean') installNegativeControl(config.mode);

const report = {
  mode: config.mode,
  skew: config.skew ?? null,
  node: process.version,
  nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
  failure: null,
  monitorInstallFailures,
  monitorsAbsent,
};

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
    nondeterminism: inPhase(nondeterminism, name),
  };
}
report.setupEnvWrites = inPhase(envWrites, 'setup');
report.control = {
  fs: globalThis.__piPurityControlFs ?? null,
  env: globalThis.__piPurityControlEnv ?? null,
  envDescriptor: globalThis.__piPurityControlEnvDescriptor ?? null,
};

writeReport(config.reportPath, JSON.stringify(report), 'utf8');
process.exit(0);
