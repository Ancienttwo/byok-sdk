// BYOK change: Modified from OAR a122061 so the startup gate uses the owned environment and typed errors (Apache-2.0).
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { SessionOptions } from "../../contracts/session.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { AcpError, acpRequestTimeoutError } from "../../shared/acp/errors.js";

interface Waiter { readonly grant: () => void }
const directories = new Map<string, Waiter[]>();

/** Resolve existing ancestors too: native startup may not have created its data directory yet. */
function canonical(directory: string): string {
  try { return realpathSync.native(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") { throw error; }
    const parent = dirname(directory);
    if (parent === directory) { throw error; }
    return join(canonical(parent), basename(directory));
  }
}

function errorReason(value: unknown): Error { return value instanceof Error ? value : new Error("OpenCode startup wait cancelled"); }

function dataDirectory(options: SessionOptions): string {
  // BYOK change: use the complete environment supplied to the owned child.
  const env = sessionEnvironment(options.env, {});
  const xdg = environmentValue(env, "XDG_DATA_HOME");
  const root = xdg === undefined || xdg === "" ? join(environmentHome(env), ".local", "share") : xdg;
  // Native Global.Path.data uses xdg-basedir, not OPENCODE_TEST_HOME.
  const directory = canonical(resolvePath(options.cwd, root, "opencode"));
  return process.platform === "win32" ? directory.toLowerCase() : directory;
}

function ownership(directory: string, waiters: Waiter[]): () => void {
  let released = false;
  return () => {
    if (released) { return; }
    released = true;
    const next = waiters.shift();
    if (next === undefined) { directories.delete(directory); }
    else { next.grant(); }
  };
}

/**
 * Only ACP startup is serialized, in this OAR process. v1 can fail during WAL
 * recovery before installing its busy timeout (#64590); v2 protects that pragma
 * but still races during fresh schema creation (#53879). No failed start retries.
 * Remove each release line's gate only after its corresponding native controls pass.
 */
// oxlint-disable-next-line typescript/promise-function-async -- The uncontended path owns the lock synchronously; waiters resolve on release or cancellation.
export function acquireOpenCodeStartup(options: SessionOptions, timeoutMs = 60_000, signal?: AbortSignal): Promise<() => void> {
  try { signal?.throwIfAborted(); } catch (error) { return Promise.reject(errorReason(error)); }
  let directory: string;
  try { directory = dataDirectory(options); }
  catch { return Promise.reject(new AcpError("startup_directory", "OpenCode could not resolve its startup data directory")); }
  const existing = directories.get(directory);
  if (existing === undefined) {
    const waiters: Waiter[] = [];
    directories.set(directory, waiters);
    return Promise.resolve(ownership(directory, waiters));
  }
  return new Promise<() => void>((resolve, reject) => {
    const clean = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const cancel = (error: unknown): void => {
      const index = existing.indexOf(waiter);
      if (index === -1) { return; } // Already acquired; cancellation cannot release another owner.
      existing.splice(index, 1); clean(); reject(errorReason(error));
    };
    const abort = (): void => { cancel(signal?.reason); };
    const waiter: Waiter = { grant: () => { clean(); resolve(ownership(directory, existing)); } };
    const timer = setTimeout(() => { cancel(acpRequestTimeoutError("startup queue", timeoutMs)); }, timeoutMs);
    existing.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
