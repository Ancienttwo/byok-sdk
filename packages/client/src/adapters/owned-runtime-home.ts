import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentHomeResolutionError, ensureDirectoryNoSymlink } from '../agent-home.js';
import { RuntimeExecutionFailure } from '../runtime-failure.js';

/** One runtime's SDK-owned home for an Agent task: which user entries it links and where the Agent's own store lives. */
export interface OwnedRuntimeHomeSpec {
  /** Prefix of every refusal reason, e.g. `codex Agent user context exclusion refused`. */
  readonly refusalPrefix: string;
  /** The directory created in the scratch directory, e.g. `codex-home`. */
  readonly name: string;
  /** The user's runtime home as the runtime resolves it; called after the Agent home check. */
  readonly userHome: () => string;
  /** The user's runtime home in refusal reasons, e.g. `CODEX_HOME`. */
  readonly userHomeLabel: string;
  /** User entries linked when present; absent ones are skipped. */
  readonly linked: readonly string[];
  /** User entries that must exist, with the refusal reason when one does not. */
  readonly required: readonly { readonly entry: string; readonly reason: string }[];
  /** The Agent's own store: each entry links to `<agentHome>/<root>/<entry>`. `label` names it in refusal reasons. */
  readonly agentStore: { readonly agentHome: string | undefined; readonly root: string; readonly entries: readonly string[]; readonly label: string };
}

/**
 * Builds a runtime's SDK-owned home in `dir` and returns it. Each entry is a
 * symbolic link, never a copy or a hard link, so a runtime that rewrites a
 * linked file (a login refresh) reaches the user's file. The Agent can write
 * in its home, so every component down to its store must be a real directory
 * inside it. Every refusal is a non-retryable start failure.
 */
export async function createOwnedRuntimeHome(spec: OwnedRuntimeHomeSpec, dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: `${spec.refusalPrefix}: ${reason}` });
  const { agentHome } = spec.agentStore;
  if (agentHome === undefined || agentHome === '') throw refuse(`the task has no sealed Agent home for its ${spec.agentStore.label}`);
  let user: string;
  try {
    user = await fs.realpath(spec.userHome());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw refuse(`the user ${spec.userHomeLabel} does not exist`);
    throw error;
  }
  for (const { entry, reason } of spec.required) {
    if (!await fs.stat(path.join(user, entry)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw refuse(reason);
  }
  const home = path.join(dir, spec.name);
  await fs.mkdir(home, { mode: 0o700 });
  const link = async (target: string, name: string, type: 'dir' | 'file') => {
    try {
      await fs.symlink(target, path.join(home, name), type);
    } catch (error) {
      if (platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw refuse('Windows refused to create a symbolic link (EPERM); turn on Developer Mode or run the daemon as an administrator');
      }
      throw error;
    }
  };
  for (const name of spec.linked) {
    const target = path.join(user, name);
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat !== undefined) await link(target, name, stat.isDirectory() ? 'dir' : 'file');
  }
  for (const name of spec.agentStore.entries) {
    const target = await ensureDirectoryNoSymlink(agentHome, path.join(agentHome, spec.agentStore.root, name)).catch((error: unknown) => {
      if (error instanceof AgentHomeResolutionError) throw refuse(`the Agent home ${spec.agentStore.label} is not a real directory inside the Agent home`);
      throw error;
    });
    await link(target, name, 'dir');
  }
  return home;
}
