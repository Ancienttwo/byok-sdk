// BYOK change: Modified from OAR 609f347 for caller-owned auth status only (Apache-2.0).
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AuthStatus, LoginAccount } from "../../contracts/login.js";
import { withQueryDeadline } from "../../shared/executable/query.js";

const STATUS_SOURCE = "codex login status";

function credential(method: string | undefined): Pick<LoginAccount, "credential" | "metering"> {
  if (method === "chatgpt") { return { credential: "account", metering: "plan" }; }
  // login status does not establish which provider bills an API key.
  return method === "apiKey" ? { credential: "api_key" } : {};
}

/**
 * `codex login status` prints to stderr and exits 0 when logged in
 * (`Logged in using ChatGPT`, or `Logged in using an API key - <masked>`),
 * 1 with `Not logged in` when logged out, and 1 with another message when
 * it cannot tell (an unreadable configuration or credential store).
 */
export function projectCodexLoginStatus(exitCode: number | null, output: string): AuthStatus {
  if (exitCode === 0) {
    const method = /Logged in using ChatGPT/u.test(output) ? "chatgpt" : (/Logged in using an API key|^API key configured -/mu.test(output) ? "apiKey" : undefined);
    return { kind: "logged_in", ...(method === undefined ? {} : { account: { method, ...credential(method) } }), source: STATUS_SOURCE };
  }
  if (exitCode === 1 && /^Not logged in\b/mu.test(output)) {
    return { kind: "logged_out", source: STATUS_SOURCE };
  }
  return {
    kind: "unknown",
    detail: `codex login status ended without an answer (exit ${String(exitCode)})`,
    source: STATUS_SOURCE,
  };
}

export async function readCodexAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  if (installation.via !== "executable") {
    return { kind: "unknown", detail: "not a machine-installed executable" };
  }
  const result = await options.run(installation.command, ["login", "status"], options);
  return projectCodexLoginStatus(result.ok ? 0 : result.exitCode, `${result.stdout}\n${result.stderr}`);
}

/** Native status can hydrate personal access tokens and identity credentials over the network. */
export async function codexAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  const status = await withQueryDeadline<AuthStatus>("Codex auth status", options.timeoutMs, async (signal) => {
    const result = await readCodexAuthStatus(installation, { ...options, signal });
    return result;
  }, { kind: "unknown", source: STATUS_SOURCE, detail: "Codex auth status timed out" });
  return status;
}
