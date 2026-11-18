// BYOK change: Modified from OAR 609f347 for owned auth status only (Apache-2.0).
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import { antigravityUsesDefaultState, ANTIGRAVITY_STATE_QUERY_UNAVAILABLE } from "./state-directory.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus } from "../../contracts/login.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { antigravityVersionPreflight } from "./version.js";

/*
 * Antigravity's own login (agy 1.5.5, 2026-11-10; experiments and notes in
 * docs/runtimes/antigravity.md#login). `agy acp --login` ("Log in with Google
 * interactively, then exit") prints
 *
 *   Open this link in a browser to log in with Google:
 *     https://accounts.google.com/o/oauth2/auth?...
 *   Then paste the authorization code, or the full URL of the page you land on, and press Enter:
 *
 * and reads that line from stdin; with none it ends `login cancelled: no
 * authorization code was entered` (exit 1). The CLI decides where the token
 * goes (a 0600 file under `<gemini-directory>/antigravity-cli/`, or a keyring it
 * detects); OAR never reads or writes it. Status is `agy models`, which
 * refuses with "Please sign in" when there is no login. Logout is agy's ACP
 * `logout` (logout.ts); print mode refuses `/logout`.
 */
const SOURCE = "agy models";
const SIGNED_OUT = /Please sign in\b/iu;

export async function readAntigravityAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const { env } = options;
  if (!antigravityUsesDefaultState(env)) { return { kind: "unknown", detail: ANTIGRAVITY_STATE_QUERY_UNAVAILABLE }; }
  const version = await antigravityVersionPreflight(installation, options);
  if (version.kind === "unsupported") {
    const { kind: _kind, reason, ...versions } = version;
    return { kind: "unknown", ...versions, detail: reason };
  }
  const result = await options.run(installation.command, ["models"], {
    env, timeoutMs: version.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.ok) { return { kind: "logged_in", source: SOURCE }; }
  // Its refusal names the missing login; any other failure (network, a crash) says nothing about it.
  if (result.exitCode === 1 && SIGNED_OUT.test(`${result.stdout}\n${result.stderr}`)) { return { kind: "logged_out", source: SOURCE }; }
  return { kind: "unknown", source: SOURCE, detail: "agy models ended without saying whether it is signed in" };
}

/** Whether Antigravity is signed in, by its own model listing (a remote call: not localOnly). */
export async function antigravityAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  try {
    const status = await withQueryDeadline<AuthStatus>("Antigravity auth status", options.timeoutMs, async (signal) => {
      const read = await readAntigravityAuthStatus(installation, { ...options, signal });
      return read;
    }, { kind: "unknown", source: SOURCE, detail: "Antigravity auth status timed out" });
    return status;
  } catch {
    return { kind: "unknown", detail: "Antigravity authentication status could not be read" };
  }
}
