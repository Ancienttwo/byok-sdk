// BYOK change: Modified from OAR bc1b2ac for SDK-owned processes and explicit environments (Apache-2.0).
import type { ExecutableInstallation } from "../../contracts/installation.js";

import type { Runtime } from "../../contracts/runtime.js";

// BYOK change: the narrow bridge reads the same declaration as Runtime.sessionCapabilities.
export const opencodeSessionCapabilities: NonNullable<Runtime["sessionCapabilities"]> = (installation) =>
  installation.via === "executable" && installation.version !== undefined && parseOpencodeRelease(installation.version)?.major === 1 ? { steer: true } : {};
import type { SessionOptions } from "../../contracts/session.js";

/** Numeric comparisons ignore suffixes; version retains the full release identifier. */
export interface OpencodeRelease { readonly major: 1 | 2; readonly minor: number; readonly patch: number; readonly version: string }

/** The two independently maintained native lines share one command name. */
export async function opencodeRelease(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env"> & { readonly signal?: AbortSignal }): Promise<OpencodeRelease> {
  // BYOK: the SDK probes once using its selected executable and process boundary.
  const version = installation.version;
  if (version === undefined) throw new Error("opencode requires a probed executable version");
  const release = parseOpencodeRelease(version);
  if (release !== undefined) { return release; }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}

/** Synchronous read of a `--version` line; undefined when it names neither line. */
export function parseOpencodeRelease(version: string): OpencodeRelease | undefined {
  const match = /^(?:opencode\s+)?v?([12])\.(\d+)\.(\d+)(\S*)$/u.exec(version.trim());
  const [, major, minor, patch, suffix] = match ?? [];
  if ((major === "1" || major === "2") && minor !== undefined && patch !== undefined) {
    return { major: major === "1" ? 1 : 2, minor: Number(minor), patch: Number(patch), version: `${major}.${minor}.${patch}${suffix ?? ""}` };
  }
  return undefined;
}

export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  const release = await opencodeRelease(installation, options);
  return release.major;
}

/** 2.3.0 runs subagents in the background and reports them through `opencode/session/child_update`. */
export function hasBackgroundChildUpdates(release: OpencodeRelease): boolean {
  return release.major === 2 && release.minor >= 3;
}
