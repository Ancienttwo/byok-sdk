import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fffExtension } from '../../bin/pi-extension-factories.js';

const FFF_TOOLS = ['fffind', 'ffgrep'] as const;

/** Use the host's verified registry projection; do not invent permission grants. */
export function piFffToolsSelected(selection: {
  tools?: readonly string[]; excludeTools?: readonly string[]; noTools?: 'all' | 'builtin';
}): boolean {
  if (selection.noTools === 'all') return false;
  return FFF_TOOLS.some(name =>
    (selection.tools === undefined || selection.tools.includes(name)) && !selection.excludeTools?.includes(name));
}

/** Ordinary RPC only: fixed names/config, ephemeral per-session ranking data. */
export function createByokFffExtension(): ExtensionFactory {
  return (pi) => {
    let dataDir: string | undefined;
    let closing = false;
    let shutdown: Promise<unknown> | undefined;
    const pending = new Set<Promise<unknown>>();
    const databaseDir = () => dataDir ??= mkdtempSync(join(tmpdir(), 'byok-pi-fff-'));
    const cleanup = () => {
      if (dataDir !== undefined) {
        rmSync(dataDir, { recursive: true, force: true });
        dataDir = undefined;
      }
    };
    const track = <T>(operation: () => T | Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error('FFF session is shutting down'));
      let promise: Promise<T>;
      try { promise = Promise.resolve(operation()); }
      catch (error) { return Promise.reject(error); }
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    };
    const context = (ctx: ExtensionContext): ExtensionContext => ({
      ...ctx,
      // Only FFF's readonly view omits mode entries; stored history and all
      // other extensions retain the original session manager.
      sessionManager: new Proxy(ctx.sessionManager, {
        get(target, property, receiver) {
          if (property === 'getEntries') {
            return () => target.getEntries().filter(entry => entry.type !== 'custom' || entry.customType !== 'fff-mode');
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    const facade: ExtensionAPI = {
      ...pi,
      getFlag(name) {
        switch (name) {
          case 'fff-mode': return 'tools-only';
          case 'fff-frecency-db': return join(databaseDir(), 'frecency');
          case 'fff-history-db': return join(databaseDir(), 'history');
          case 'fff-enable-root-scan': return false;
          case 'fff-enable-home-scan': return true;
          case 'fff-follow-symlinks': return true;
          case 'fff-warn-home-scan': return false;
          default: return pi.getFlag(name);
        }
      },
      // This RPC factory exposes search tools, not user configuration commands.
      registerFlag() {},
      registerCommand() {},
      registerTool(tool) {
        if (!FFF_TOOLS.some(name => name === tool.name)) throw new Error(`Unexpected FFF tool: ${tool.name}`);
        pi.registerTool({ ...tool, execute: (...args) => track(() => tool.execute(...args)) });
      },
      // Preserve Pi's overloaded public event API while decorating its callbacks.
      on: new Proxy(pi.on, {
        apply(target, _receiver, [event, handler]) {
          return Reflect.apply(target, pi, [event, (payload: unknown, ctx: ExtensionContext) => {
            if (event === 'session_shutdown') {
              return shutdown ??= (async () => {
                closing = true;
                await Promise.allSettled([...pending]);
                try { return await handler(payload, context(ctx)); }
                finally { cleanup(); }
              })();
            }
            return track(() => handler(payload, context(ctx)));
          }]);
        },
      }),
    };

    // pi-fff 0.11.0 synchronously reads global JSON before consulting flags.
    // Redirect that one documented-env read to an empty owned directory, with
    // no await/interleaving; flags above own every later configuration value.
    const configDir = mkdtempSync(join(tmpdir(), 'byok-pi-fff-config-'));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousMultiGrep = process.env.PI_FFF_MULTIGREP;
    try {
      process.env.PI_CODING_AGENT_DIR = configDir;
      delete process.env.PI_FFF_MULTIGREP;
      const result = fffExtension(facade);
      if (result !== undefined) throw new Error('Pinned FFF factory must be synchronous');
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      if (previousMultiGrep === undefined) delete process.env.PI_FFF_MULTIGREP;
      else process.env.PI_FFF_MULTIGREP = previousMultiGrep;
      rmSync(configDir, { recursive: true, force: true });
    }
  };
}
