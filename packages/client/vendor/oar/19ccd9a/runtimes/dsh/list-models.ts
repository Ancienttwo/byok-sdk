// BYOK change: Modified from OAR 609f347 for caller-owned reader processes and explicit environments (Apache-2.0).
import { withQueryDeadline } from "../../shared/executable/query.js";
import type { OwnedReaderOptions } from "../../contracts/list-models.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ModelEntry, ListModelsResult } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { DshCommandError, dshControl } from "./control.js";
import { launchDsh, type DshLaunch } from "./launch.js";
import { profileWaitReason, type DshProfileWait } from "./profile-startup.js";
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

/** Classify DSH's native `models` catalog without inspecting environment variables. */
export function dshCatalogResult(catalog: JsonRecord): ListModelsResult {
  const models = projectDshModels(catalog);
  if (models.length > 0) {
    return { kind: "ok", models };
  }
  const providers = asRecordList(catalog.providers);
  const selected = asRecord(catalog.default);
  const defaultProvider = typeof selected?.provider === "string" && selected.provider.length > 0 ? selected.provider : undefined;
  if (defaultProvider !== undefined) {
    const entry = providers.find((provider) => provider.id === defaultProvider);
    if (entry !== undefined && typeof entry.failure !== "string" && asRecordList(entry.models).length === 0) {
      const defaultModel = typeof selected?.model === "string" && selected.model.length > 0 ? selected.model : undefined;
      const target = defaultModel === undefined ? `"${defaultProvider}"` : `"${defaultProvider}" (${defaultProvider}/${defaultModel})`;
      return {
        kind: "unauthenticated",
        detail: `DSH default provider ${target} listed no models; configure credentials for ${defaultProvider}.`,
      };
    }
  }
  // BYOK change: a provider's native failure text is untrusted diagnostics, so the refusal omits it.
  if (providers.some((provider) => typeof provider.failure === "string")) {
    return { kind: "unsupported", reason: "DSH could not list any provider's models" };
  }
  return { kind: "ok", models };
}

/** Native `llm.listProviders`, `listModels` and `resolveModelInfo`, in a short-lived process started the way a session is. */
export async function dshListModels(installation: AvailableInstallation, options: OwnedReaderOptions, launch: DshLaunch): Promise<ListModelsResult> {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "DSH model listing requires its executable" }; }
  const refusal = dshVersionUnsupported(installation.version);
  if (refusal !== null) { return refusal; }
  const profileWait: DshProfileWait = {};
  return withQueryDeadline<ListModelsResult>("DSH model listing", options.timeoutMs, async (signal, own) => {
    // BYOK change: the cold-profile wait ends with the listing's deadline or the caller's abort.
    const { child, profileLoaded } = await launchDsh(options.spawn, installation.command, launch, { signal, profileWait });
    own(child);
    const control = dshControl(child, () => {}, undefined, profileLoaded);
    try {
      await control.ready;
      const catalog = await control.request("models", {}, options.timeoutMs);
      return dshCatalogResult(catalog);
    } catch (error) {
      if (error instanceof DshCommandError && error.code === "native_method_unavailable") { return { kind: "unsupported", reason: "DSH does not expose its native model catalog" }; }
      throw error;
    }
  }, undefined, options.signal).catch((error: unknown) => {
    const reason = profileWaitReason(profileWait);
    if (reason !== undefined && error instanceof Error && error.name === "TimeoutError") { throw new DOMException(reason, "TimeoutError"); }
    throw error;
  });
}
