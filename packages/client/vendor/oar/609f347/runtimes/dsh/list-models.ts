// BYOK change: Modified from OAR 609f347 for caller-owned reader processes and explicit environments (Apache-2.0).
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ModelEntry, ListModelsResult } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { DshCommandError, dshControl } from "./control.js";
import { launchDsh, type DshLaunch } from "./launch.js";
import { dshVersionUnsupported } from "./version.js";

/** The native catalog as `Session.model` selectors. A provider that could not list is not a model; the caller decides what no model means. */
export function projectDshModels(catalog: JsonRecord): readonly ModelEntry[] {
  const selected = asRecord(catalog.default);
  return asRecordList(catalog.providers).flatMap((provider) => {
    if (typeof provider.id !== "string") { return []; }
    const providerId = provider.id;
    return asRecordList(provider.models).flatMap((model): ModelEntry[] => {
      if (typeof model.id !== "string") { return []; }
      const reasoning = asRecord(model.reasoning);
      const efforts = reasoning === null ? undefined : effortLevelsOf(asRecordList(reasoning.efforts).map((effort) => effort.id));
      return [{
        id: `${providerId}/${model.id}`,
        ...(typeof model.name === "string" ? { displayName: model.name } : {}),
        provider: { id: providerId, ...(typeof provider.name === "string" ? { displayName: provider.name } : {}) },
        ...(efforts === undefined ? {} : { effortLevels: efforts }),
        ...(typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}),
        ...(selected?.provider === providerId && selected.model === model.id ? { default: true as const } : {}),
      }];
    });
  });
}

/** Native `llm.listProviders`, `listModels` and `resolveModelInfo`, in a short-lived process started the way a session is. */
export async function dshListModels(installation: AvailableInstallation, options: OwnedReaderOptions, launch: DshLaunch): Promise<ListModelsResult> {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "DSH model listing requires its executable" }; }
  const refusal = dshVersionUnsupported(installation.version);
  if (refusal !== null) { return refusal; }
  const child = await launchDsh(options.spawn, installation.command, launch);
  const control = dshControl(child, () => {});
  try {
    await control.ready;
    const catalog = await control.request("models", {}, options.timeoutMs);
    const models = projectDshModels(catalog);
    if (models.length === 0) {
      if (asRecordList(catalog.providers).some(provider => typeof provider.failure === "string")) {
        return { kind: "unsupported", reason: "DSH could not list any provider's models" };
      }
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof DshCommandError && error.code === "native_method_unavailable") { return { kind: "unsupported", reason: "DSH does not expose its native model catalog" }; }
    throw error;
  } finally {
    child.kill();
    await child.exited;
  }
}
