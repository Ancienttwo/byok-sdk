import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import type { CredentialRedactor } from "../credential-redactor.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { acpReportedEffort } from "./model.js";
import { AcpError } from "./errors.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

type WaitForConfirmation = (signal: AbortSignal) => Promise<void>;

export interface AcpConfigUpdates {
  observe(notification: unknown): void;
  confirm<T>(sessionId: string, configId: string, value: string, run: (wait: WaitForConfirmation) => Promise<T>): Promise<T>;
}

/** Observe before sending; wait after the native answer, inside the same request deadline. */
export function createAcpConfigUpdates(redact?: CredentialRedactor["redactValue"]): AcpConfigUpdates {
  const listeners = new Set<(sessionId: string, update: JsonRecord, safe: JsonRecord | null) => void>();
  return {
    observe(notification): void {
      const params = asRecord(notification), update = asRecord(params?.update);
      if (typeof params?.sessionId !== "string" || update?.sessionUpdate !== "config_option_update") { return; }
      const safe = redact === undefined ? update : asRecord(asRecord(redact(params))?.update);
      for (const listener of listeners) listener(params.sessionId, update, safe);
    },
    async confirm(sessionId, configId, value, run) {
      const state: { observed: boolean; current: unknown; reported: unknown; effort?: string | null; changed?: () => void } = { observed: false, current: null, reported: null };
      const listener = (id: string, update: JsonRecord, safe: JsonRecord | null): void => {
        if (id !== sessionId) { return; }
        const option = asRecordList(update.configOptions).find(entry => entry.id === configId);
        if (option === undefined) { return; }
        const retained = asRecordList(safe?.configOptions).find(entry => entry.id === configId);
        state.observed = true;
        state.current = option.currentValue;
        state.reported = retained?.currentValue;
        state.effort = acpReportedEffort(safe);
        state.changed?.();
      };
      listeners.add(listener);
      try {
        return await run(async signal => {
          signal.throwIfAborted();
          if (state.observed && state.current === value) { return; }
          do {
            signal.throwIfAborted();
            const matched = Promise.withResolvers<void>();
            // oxlint-disable-next-line eslint/no-loop-func -- Native callbacks update state; each iteration owns its own deferred.
            state.changed = (): void => { if (state.current === value) { matched.resolve(); } };
            const aborted = (): void => { matched.reject(signal.reason); };
            signal.addEventListener("abort", aborted, { once: true });
            // Recheck after draining the notification callback: another update
            // in the same batch may already have replaced the matching value.
            try { await matched.promise; }
            finally { signal.removeEventListener("abort", aborted); }
          // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Notifications update the observed state while awaiting.
          } while (state.current !== value);
        });
      } catch (error) {
        // An explicit RPC failure or process exit retains its own classification.
        // A conflicting notification is an observation, not proof of refusal,
        // until the request's existing deadline runs out.
        if (error instanceof AcpError && error.kind === "timeout" && state.observed && state.current !== value) {
          const message = state.reported === undefined ? `ACP config_option_update did not confirm requested ${configId}`
            : `ACP config_option_update left ${configId} at ${String(state.reported)} although ${value} was requested${configId === "model" && typeof state.effort === "string" ? ` (native thought_level=${state.effort})` : ""}`;
          throw configId === "model" ? new ModelConfirmationError(message, { requested: value, reported: typeof state.reported === "string" ? state.reported : null }) : new UnsupportedOptionError("effort", message);
        }
        throw error;
      } finally {
        listeners.delete(listener);
      }
    },
  };
}
