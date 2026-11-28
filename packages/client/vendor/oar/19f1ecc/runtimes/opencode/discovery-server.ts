// BYOK change: Modified from OAR 87c0929 to spawn through the caller-owned reader process (Apache-2.0).
import { randomBytes } from "node:crypto";
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { LineProcess } from "../codex/app-server-client.js";
import type { OwnQueryProcess } from "../../shared/executable/query.js";
import { nativeRows } from "../../shared/inventory.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

// BYOK change: provider-auth-server.ts's serveEnvironment, inlined so the login server and its process layer stay out of the vendored closure.
function serveEnvironment(env: Readonly<Record<string, string>>, password: string, modelsFetch: "disable" | "inherit"): Record<string, string> {
  const inherited = { ...env };
  delete inherited.OPENCODE_SERVER_USERNAME;
  return {
    ...inherited,
    // OpenCode reads OPENCODE_PASSWORD first, then OPENCODE_SERVER_PASSWORD.
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...(modelsFetch === "disable" ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}),
    ...(process.platform === "win32" ? {} : { BROWSER: "true" }),
  };
}

type Catalog = "models" | "skills";

async function endpoint(child: LineProcess, catalog: Catalog, signal: AbortSignal): Promise<string> {
  const ready = Promise.withResolvers<string>();
  signal.addEventListener("abort", () => { ready.reject(new Error("OpenCode discovery stopped")); }, { once: true });
  child.onExit(code => { ready.reject(new Error(`OpenCode discovery exited (code ${String(code)})`)); });
  child.onLine((line) => {
    const url = catalog === "models" ? asRecord(parseJson(line))?.url : /^server listening on (\S+)$/u.exec(line)?.[1];
    if (typeof url !== "string") { return; }
    const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/?$/u.exec(url);
    const port = Number(match?.[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) { ready.resolve(`http://127.0.0.1:${String(port)}`); }
  });
  const value = await ready.promise;
  return value;
}

async function query(origin: string, password: string, cwd: string, signal: AbortSignal, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${origin}${path}`, {
    signal, redirect: "error", headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(cwd),
    },
  });
  if (!response.ok) { throw new Error(`OpenCode discovery ${path} failed (HTTP ${String(response.status)})`); }
  const envelope = asRecord(parseJson(await response.text()));
  return nativeRows(envelope?.data);
}

/** Start a private foreground listener tied to the owning query's deadline and cleanup. */
// BYOK change: the caller's spawn owns the process tree and its shutdown; own() kills and awaits it when the query ends.
export async function openDiscoveryServer(spawn: OwnedReaderOptions["spawn"], command: string, cwd: string, env: Readonly<Record<string, string>>, catalog: Catalog, signal: AbortSignal, own: OwnQueryProcess) {
  const password = randomBytes(24).toString("base64url");
  const args = ["serve", ...(catalog === "models" ? ["--stdio"] : []), "--hostname", "127.0.0.1", "--port", "0"];
  const childEnv = serveEnvironment(env, password, catalog === "models" ? "inherit" : "disable");
  const child = own(spawn(command, args, { cwd, env: childEnv }));
  const [, origin] = await Promise.all([child.spawned, endpoint(child, catalog, signal)]);
  return async (path: string): Promise<JsonRecord[]> => {
    const rows = await query(origin, password, cwd, signal, path);
    return rows;
  };
}
