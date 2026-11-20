// BYOK change: Modified from OAR 609f347 for caller-owned auth status only (Apache-2.0).
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AuthStatus } from "../../contracts/login.js";
import { withQueryDeadline } from "../../shared/executable/query.js";

const SOURCE = "grok models";
const SIGNED_OUT = "You are not authenticated.";
/** Its first line with a sign-in (1.0.77, a real login): `You are logged in with grok.com.` */
const SIGNED_IN = /^You are logged in with (\S+?)\.$/mu;

export async function readGrokAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const result = await options.run(installation.command, ["models"], options);
  if (!result.ok) { return { kind: "unknown", source: SOURCE, detail: "grok models failed" }; }
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes(SIGNED_OUT)) { return { kind: "logged_out", source: SOURCE }; }
  const method = SIGNED_IN.exec(output)?.[1];
  return method === undefined
    ? { kind: "unknown", source: SOURCE, detail: "grok models said neither that it is logged in nor that it is not" }
    : { kind: "logged_in", account: { method }, source: SOURCE };
}

/** Whether Grok is signed in, by its own model listing. */
export async function grokAuthStatus(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<AuthStatus> {
  const timeoutMs = options.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const status = await withQueryDeadline<AuthStatus>("Grok auth status", timeoutMs, async (signal) => {
    const read = await readGrokAuthStatus(installation, { ...options, signal });
    return read;
  }, { kind: "unknown", source: SOURCE, detail: "Grok auth status timed out" });
  if (status.kind !== "logged_out" || installation.via !== "executable") { return status; }
  const { previousGrokEmail } = await import("./account-info.js");
  const email = await previousGrokEmail(installation.command, options, deadline - Date.now());
  return email === null ? status : { ...status, lastAccount: { email } };
}
