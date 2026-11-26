// BYOK change: Modified from OAR 609f347 for caller-owned reader processes and explicit environments (Apache-2.0).
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ModelEntry, ListModelsResult } from "../../contracts/list-models.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { listV2Models } from "./list-models-v2.js";
import { opencodeMajor } from "./version.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project `opencode models --verbose` (1.18.30, cli/cmd/models.ts): for each
 * model of every configured provider, a `provider/model` line, then the
 * model as indented JSON closed by a `}` line. The `provider/model` line is
 * the id `opencode acp` offers in its `model` config option. The model's
 * `variants` keys are the values of its `effort` (`thought_level`) option,
 * which `SessionOptions.effort` sets (later builds add a `default` value
 * there, meaning no variant, which is not a level). No `defaultEffort`: which
 * variant a new session starts on is the session's to report.
 */
export function projectOpencodeModels(stdout: string): ModelEntry[] {
  const lines = stdout.split(/\r?\n/u);
  const entries: ModelEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    const id = /^(\S+\/\S+)$/u.exec(lines[index] ?? "")?.[1];
    index += 1;
    if (id === undefined || lines[index] !== "{") {
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      body.push(line);
      index += 1;
      if (line === "}") {
        break;
      }
    }
    const model = asRecord(parseJson(body.join("\n")));
    const displayName = text(model?.name);
    const effortLevels = Object.keys(asRecord(model?.variants) ?? {}).filter(level => level !== "default");
    const providerId = text(model?.providerID);
    entries.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(effortLevels.length === 0 ? {} : { effortLevels }),
      ...(providerId === undefined ? {} : { provider: { id: providerId } }),
    });
  }
  return entries;
}

/**
 * Reads opencode's model catalog in the listing's cwd, whose project config can
 * add providers; the first run after an install also fetches models.dev.
 */
export async function opencodeListModels(installation: AvailableInstallation, options: OwnedReaderOptions): Promise<ListModelsResult> {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "opencode model listing requires the opencode executable" };
  }
  const cwd = listingCwd(options);
  const major = await opencodeMajor(installation, { cwd, ...(options.env === undefined ? {} : { env: options.env }) });
  if (major === 2) {
    // BYOK change: the v2 loopback catalog reads through the caller's spawn, bounded by the reader's deadline and signal.
    return withQueryDeadline<ListModelsResult>("OpenCode model listing", options.timeoutMs, async (signal, own) => listV2Models(options.spawn, installation.command, cwd, options.env, signal, own), undefined, options.signal);
  }
  const result = await options.run(installation.command, ["models", "--verbose"], { ...options, cwd });
  if (!result.ok) {
    throw new Error(`Failed to list opencode models (exit ${String(result.exitCode)})`);
  }
  return { kind: "ok", models: projectOpencodeModels(result.stdout) };
}
