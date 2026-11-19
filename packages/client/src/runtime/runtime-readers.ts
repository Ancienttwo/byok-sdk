import path from 'node:path';
import { findRuntimeCommandOnPath, resolveRuntimeInvocation, runtimeInvocationHost } from '../adapters/runtime-invocation.js';
import type { RuntimeAdapter } from '../types.js';
import { isRuntimeExecutionFailure } from '../runtime-failure.js';
import { sessionCredentialRedactor } from './claude-session-runtime.js';
import { createOwnedLineProcessSpawn } from './owned-line-process.js';
import type { ModelReader, OwnedReaderOptions, ReaderCommandOptions, ReaderCommandResult, UsageReader, VersionRefusal } from './oar-reader-contract.js';
import type { RuntimeAccountUsage, RuntimeListModelsOptions, RuntimeModelCatalog, RuntimeReadOptions } from './runtime-reader-types.js';

export const RUNTIME_READ_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Bounds the whole query, including environment resolution and native startup. */
export async function boundRuntimeRead<T>(caller: AbortSignal | undefined, query: (signal: AbortSignal, stopped: Promise<never>) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]);
  signal.throwIfAborted();
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(controller.signal.aborted ? new Error('runtime read timed out') : new Error('runtime read cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), RUNTIME_READ_TIMEOUT_MS);
  timer.unref();
  try {
    return await Promise.race([stopped, query(signal, stopped)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

type ReaderEnv = Readonly<Record<string, string>>;
interface ReaderConfig {
  readonly nativeAssetRoot?: string;
  readonly spawnFn?: NonNullable<Parameters<typeof createOwnedLineProcessSpawn>[0]>['spawnFn'];
  readonly command: (env: ReaderEnv) => string;
  readonly version: (stdout: string) => string | undefined;
  readonly versionRefusal?: (version: string | undefined) => VersionRefusal | null;
  readonly environment?: (env: ReaderEnv) => { env: ReaderEnv; close?: () => Promise<void> } | Promise<{ env: ReaderEnv; close?: () => Promise<void> }>;
  readonly authenticate?: (env: ReaderEnv, signal: AbortSignal) => Promise<{
    readonly env: ReaderEnv;
    readonly credentials: readonly string[];
    readonly close?: () => Promise<void>;
  }>;
}

type ActiveReader = OwnedReaderOptions & { readonly signal: AbortSignal };
type AuthenticateReader = <T>(env: ReaderEnv, signal: AbortSignal, use: (authenticated: ReaderEnv) => Promise<T>) => Promise<T>;
type AuthenticatedModelReader = (
  ...args: [...Parameters<ModelReader>, withAuthentication: (read: (reader: OwnedReaderOptions) => Promise<RuntimeModelCatalog>) => Promise<RuntimeModelCatalog>]
) => Promise<RuntimeModelCatalog>;

/** Each adapter owns one cache entry for its current executable and version. */
export function createRuntimeReaders(adapter: RuntimeAdapter, config: ReaderConfig) {
  let cache: { key: string; catalog: RuntimeModelCatalog } | undefined;
  const spawn = createOwnedLineProcessSpawn({ nativeAssetRoot: config.nativeAssetRoot, spawnFn: config.spawnFn, label: `${adapter.descriptor.id} reader` });
  const read = <T>(options: RuntimeReadOptions, query: (
    installation: Parameters<ModelReader>[0], reader: ActiveReader, key: string | undefined,
    redactValue: <Value>(value: Value) => Value, authenticate: AuthenticateReader,
  ) => Promise<T>, unsupported: (refusal?: VersionRefusal) => T) => boundRuntimeRead(options.signal, async (signal, stopped) => {
    const { env: base } = await adapter.runtimeEnvironment();
    signal.throwIfAborted();
    const { env, close } = await (config.environment?.(base) ?? { env: base });
    try {
      signal.throwIfAborted();
      const redactor = sessionCredentialRedactor({ env: base });
      for (const value of sessionCredentialRedactor({ env }).values()) redactor.add(value);
      const authenticate: AuthenticateReader = async (baseEnv, requestSignal, use) => {
        if (config.authenticate === undefined) return use(baseEnv);
        const { env: authenticated, credentials, close } = await config.authenticate(baseEnv, requestSignal);
        try {
          requestSignal.throwIfAborted();
          for (const value of credentials) redactor.addExplicit(value);
          return await Promise.race([stopped, use(authenticated)]);
        } finally {
          await close?.();
        }
      };
      const children = new Set<ReturnType<typeof spawn>>();
      const terminate = () => { for (const child of children) child.kill(); };
      const ownedSpawn: typeof spawn = (command, args, processOptions) => {
        signal.throwIfAborted();
        const invocation = resolveRuntimeInvocation(command, runtimeInvocationHost(processOptions.env));
        const child = spawn(invocation.command, [...invocation.args, ...args], processOptions);
        children.add(child);
        const release = () => { children.delete(child); };
        void child.exited.then(release, release);
        if (signal.aborted) child.kill();
        return child;
      };
      async function run(command: string, args: readonly string[], commandOptions: ReaderCommandOptions): Promise<ReaderCommandResult> {
        const commandSignal = commandOptions.signal;
        commandSignal?.throwIfAborted();
        const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
        let bytes = 0;
        let overflow = false;
        const child = ownedSpawn(command, args, { ...commandOptions, onOutput(stream, chunk) {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) { overflow = true; child.kill(); }
          else chunks[stream].push(chunk);
        } });
        const stop = () => child.kill();
        commandSignal?.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(stop, commandOptions.timeoutMs);
        timer.unref();
        try {
          await child.spawned;
          const exitCode = await child.exited;
          if (overflow) throw new Error('runtime reader output exceeded its byte limit');
          if (!child.exitedOnItsOwn) throw new Error('runtime reader command did not complete');
          return { ok: exitCode === 0, exitCode, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() };
        } finally {
          clearTimeout(timer);
          commandSignal?.removeEventListener('abort', stop);
        }
      }
      signal.addEventListener('abort', terminate, { once: true });
      try {
        const command = config.command(base);
        const host = runtimeInvocationHost(env);
        const executable = path.isAbsolute(command) ? command : findRuntimeCommandOnPath(command, host);
        const reader = { env, signal, timeoutMs: RUNTIME_READ_TIMEOUT_MS, spawn: ownedSpawn, run, redact: redactor.redact };
        if (executable === undefined) return unsupported();
        const probe = await run(executable, ['--version'], reader);
        if (!probe.ok) return unsupported();
        const version = config.version(probe.stdout || probe.stderr);
        const refusal = config.versionRefusal?.(version);
        if (refusal) return unsupported(refusal);
        const installation = { kind: 'available', via: 'executable', command: executable, ...(version === undefined ? {} : { version }) } as const;
        const key = version === undefined ? undefined : `${adapter.descriptor.id}\0${executable}\0${version}`;
        // Cancellation must also unwind the resource scope if the reader has not settled.
        return await Promise.race([stopped, query(installation, reader, key, redactor.redactValue, authenticate)]);
      } catch (error) {
        if (signal.aborted || isRuntimeExecutionFailure(error)) throw error;
        // Native exception text/causes can also contain credentials from a runtime's own store.
        throw new Error('runtime reader failed');
      } finally {
        signal.removeEventListener('abort', terminate);
        terminate();
      }
    } finally {
      await close?.();
    }
  });

  return {
    listModels(options: RuntimeListModelsOptions, reader: AuthenticatedModelReader): Promise<RuntimeModelCatalog> {
      return read(options, async (installation, owned, key, redactValue, authenticate) => {
        if (!options.refresh && key !== undefined && cache?.key === key) return structuredClone(cache.catalog);
        cache = undefined;
        const withAuthentication = (use: (reader: OwnedReaderOptions) => Promise<RuntimeModelCatalog>) =>
          authenticate(owned.env, owned.signal, env => use({ ...owned, env }));
        const result = redactValue(await reader(installation, owned, withAuthentication));
        owned.signal.throwIfAborted();
        // Unauthenticated details can include native credential-store diagnostics.
        if (result.kind === 'unauthenticated') return { kind: 'unauthenticated' };
        if (result.kind === 'ok' && key !== undefined) cache = { key, catalog: structuredClone(result) };
        return result;
      }, refusal => refusal ?? { kind: 'unsupported', reason: 'runtime installation unavailable' });
    },
    accountUsage(options: RuntimeReadOptions, reader: UsageReader): Promise<RuntimeAccountUsage> {
      return read(options, async (installation, owned, _key, redactValue, authenticate) => {
        const run: OwnedReaderOptions['run'] = (command, args, commandOptions) => {
          const signal = commandOptions.signal === undefined || commandOptions.signal === owned.signal
            ? owned.signal : AbortSignal.any([owned.signal, commandOptions.signal]);
          return authenticate(commandOptions.env, signal, env => owned.run(command, args, { ...commandOptions, env, signal }));
        };
        return redactValue(await reader(installation, config.authenticate === undefined ? owned : { ...owned, run }));
      }, refusal => refusal === undefined
        ? { kind: 'unsupported', reason: 'unsupported_installation' }
        : { kind: 'unsupported', reason: 'version_unsupported', requiredVersion: refusal.requiredVersion,
          ...(refusal.installedVersion === undefined ? {} : { installedVersion: refusal.installedVersion }) });
    },
  };
}
