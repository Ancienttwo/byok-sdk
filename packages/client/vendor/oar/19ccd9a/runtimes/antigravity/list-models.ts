// BYOK change: Modified from OAR 609f347 for caller-owned reader processes and explicit environments (Apache-2.0).
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ListModelsResult } from "../../contracts/list-models.js";
import { withQueryDeadline, type OwnQueryProcess } from "../../shared/executable/query.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { hasAcpCapability } from "../../shared/acp/profile.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { antigravityAcpArgs } from "./session.js";
import { antigravityVersionPreflight } from "./version.js";
import { projectAntigravityModels, readAntigravityModelMenus } from "./model-menus.js";

export { projectAntigravityModels } from "./model-menus.js";

async function readNewSession(command: string, cwd: string, timeoutMs: number, options: OwnedReaderOptions, own: OwnQueryProcess): Promise<ModelEntry[] | undefined> {
  const runtime = own(startAcpProcess(options.spawn, command, antigravityAcpArgs(options.env), createClient({ name: "oar" }), { cwd, env: options.env, redact: options.redact }));
  const initialize = methods.agent.initialize;
  const initialized = asRecord(await withAcpDeadline(
    runtime,
    initialize,
    timeoutMs,
    (requestOptions) => runtime.connection.agent.request(initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "oar", version: "0.0.0" },
    }, requestOptions),
  ));
  // Native configuration selects authentication; no login flow is started.
  const newSession = methods.agent.session.new;
  const response = await withAcpDeadline(
    runtime,
    newSession,
    timeoutMs,
    (requestOptions) => runtime.connection.agent.request<JsonRecord>(
      newSession,
      { cwd, mcpServers: [] },
      requestOptions,
    ),
  );
  const capabilities = asRecord(asRecord(initialized?.agentCapabilities)?.sessionCapabilities);
  try {
    const fallback = projectAntigravityModels(response);
    if (fallback === undefined) { return undefined; }
    return await readAntigravityModelMenus(response, fallback, (configId, value) => withAcpDeadline(
      runtime, "session/set_config_option", timeoutMs,
      (requestOptions) => runtime.connection.agent.request("session/set_config_option", { sessionId: response.sessionId, configId, value }, requestOptions),
    ));
  } finally {
    if (typeof response.sessionId === "string" && hasAcpCapability(capabilities?.close)) {
      // Restoration errors still fail the listing, even if native close succeeds.
      await withAcpDeadline(runtime, methods.agent.session.close, timeoutMs, (requestOptions) => runtime.connection.agent.request(methods.agent.session.close, { sessionId: response.sessionId }, requestOptions)).catch(() => {});
    }
  }
}

export async function antigravityListModels(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<ListModelsResult> {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "antigravity model listing requires the agy CLI executable" };
  }
  try {
    return await withQueryDeadline<ListModelsResult>("Antigravity model listing", options.timeoutMs, async (signal, own) => {
      const version = await antigravityVersionPreflight(installation, { ...options, signal });
      if (version.kind === "unsupported") { return version; }
      const models = await readNewSession(installation.command, listingCwd(options), version.timeoutMs, options, own);
      if (models === undefined) {
        return { kind: "unsupported", reason: "this agy CLI build returns no model config option on session/new" };
      }
      return { kind: "ok", models };
    }, undefined, options.signal);
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: error.message };
    }
    throw new Error("Failed to list Antigravity models", { cause: error });
  }
}
