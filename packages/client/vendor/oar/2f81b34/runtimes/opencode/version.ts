// BYOK change: Modified from OAR 2f81b34 for SDK-owned processes and explicit environments (Apache-2.0).
import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";

/** A native release's numeric version; a prerelease suffix compares as its release. */
export interface OpencodeRelease { readonly major: 1 | 2; readonly minor: number; readonly patch: number }

/** The two independently maintained native lines share one command name. */
export async function opencodeRelease(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<OpencodeRelease> {
  // BYOK: the SDK probes once using its selected executable and process boundary.
  const version = installation.version;
  if (version === undefined) throw new Error("opencode requires a probed executable version");
  const match = /^(?:opencode\s+)?v?([12])\.(\d+)\.(\d+)(?:\S*)$/u.exec(version.trim());
  const [, major, minor, patch] = match ?? [];
  if ((major === "1" || major === "2") && minor !== undefined && patch !== undefined) {
    return { major: major === "1" ? 1 : 2, minor: Number(minor), patch: Number(patch) };
  }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}

export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  const release = await opencodeRelease(installation, options);
  return release.major;
}

/** 2.3.0 runs subagents in the background and reports them through `opencode/session/child_update`. */
export function hasBackgroundChildUpdates(release: OpencodeRelease): boolean {
  return release.major === 2 && release.minor >= 3;
}
