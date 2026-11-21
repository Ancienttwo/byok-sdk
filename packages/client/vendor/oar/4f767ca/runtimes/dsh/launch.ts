// BYOK change: Modified from OAR bc1b2ac for an injected process, an explicit environment and a caller-owned directory (Apache-2.0).
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonRecord } from "../../shared/json.js";
import type { LineProcess, SpawnLineProcess } from "../codex/app-server-client.js";
import { dshBridgeSource } from "./bridge.js";
import { acquireDshProfile } from "./profile-startup.js";

// BYOK change: the abort reads the process table before its native cancel, as the ACP stack does.
export interface DshLineProcess extends LineProcess {
  observeDescendants(): void;
}
export type SpawnDshLineProcess = (...args: Parameters<SpawnLineProcess>) => DshLineProcess;

/** BYOK change: the caller owns the process, its directory and the patch that names the provider route. */
export interface DshLaunch {
  /** The process cwd and the private home of the bridge files, removed with the execution. */
  readonly directory: string;
  /** Applied before the bridge overlay. */
  readonly patches: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const SESSION_LOG_PLUGIN_ID = "session-log-deepseek";
const SESSION_LOG_PLUGIN_NAME = "@deepseek-ai/dsh-session-log-deepseek";

export interface DshLaunchOptions {
  readonly mcpRows?: readonly JsonRecord[];
  readonly disableSessionLogUpload?: boolean;
  readonly signal?: AbortSignal;
}

/** BYOK change: the caller's process with the profile-startup release; `profileReady` runs once the bridge reports ready. */
export interface LaunchedDsh {
  readonly child: DshLineProcess;
  readonly profileReady: () => void;
}

/**
 * One owned `dsh --profile acp` process with the ACP protocol plugin off and the
 * bridge on. The profile supplies the native core and its stdin shutdown; no ACP
 * message is exchanged. The overlay is an invocation layer: it edits no user file.
 */
export async function launchDsh(spawnLineProcess: SpawnDshLineProcess, command: string, launch: DshLaunch, options: DshLaunchOptions = {}): Promise<LaunchedDsh> {
  const { mcpRows = [], disableSessionLogUpload = false, signal } = options;
  const bridge = path.join(launch.directory, "oar-dsh-bridge.mjs");
  const patch = path.join(launch.directory, "oar-dsh-bridge.patch.json");
  await writeFile(bridge, dshBridgeSource, { mode: 0o600, flag: "wx" });
  const bridgeConfig = {
    mcpEntries: mcpRows.map((row) => row.id),
    ...(disableSessionLogUpload ? { sessionLogPlugin: { id: SESSION_LOG_PLUGIN_ID, name: SESSION_LOG_PLUGIN_NAME } } : {}),
  };
  const patchRows: readonly unknown[] = [
    { id: "acp", disabled: true },
    { insert: [...mcpRows, { id: "oar-dsh-bridge", name: pathToFileURL(bridge).href, config: bridgeConfig }] },
    ...(disableSessionLogUpload ? [{ id: SESSION_LOG_PLUGIN_ID, name: SESSION_LOG_PLUGIN_NAME, config: { enabled: false } }] : []),
  ];
  await writeFile(patch, JSON.stringify(patchRows), { mode: 0o600, flag: "wx" });
  // BYOK change: the profile resolves from the caller's environment and directory, the child's own.
  const finish = await acquireDshProfile(launch.env, launch.directory, signal);
  try {
    signal?.throwIfAborted();
    const child = spawnLineProcess(command, ["--profile", "acp", ...launch.patches.flatMap((file) => ["--patch", file]), "--patch", patch], { cwd: launch.directory, env: launch.env });
    child.onExit(() => { finish(false); });
    await child.spawned;
    return { child, profileReady: () => { finish(true); } };
  } catch (error) { finish(false); throw error; }
}
