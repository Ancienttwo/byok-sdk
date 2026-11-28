import type { ModelChoice } from "../../../../src/host/conversation/catalog.ts";
import type { RuntimeView } from "../../../../src/host/settings/types.ts";
import { runtimeStatus, runtimeStatusMeta, type RuntimeStatusKey, type RuntimeStatusMeta } from "../settings/runtimeStatus.ts";

/**
 * The statuses of a runtime that is present and not version-blocked (#2546): only these take a new Bot or a re-pointed
 * one. A sign-out still shows, with its guidance; a missing runtime, a failed or timed-out check and a blocked version
 * do not take one.
 */
const SELECTABLE: ReadonlySet<RuntimeStatusKey> = new Set(["signed-in", "signed-out", "untested-version", "not-checked"]);

export interface ChoiceAvailability {
  readonly status: RuntimeStatusMeta;
  readonly selectable: boolean;
}

/**
 * A choice's availability from the latest `settings.device` read, in the one runtime status vocabulary. A runtime the
 * read does not report (no read yet, or the Host did not detect it) is not checked and takes no Bot.
 */
export function choiceAvailability(choice: ModelChoice, runtimes: readonly RuntimeView[] | undefined): ChoiceAvailability {
  const runtime = runtimes?.find((view) => view.id === choice.runtime);
  if (runtime === undefined) {
    return { status: runtimeStatusMeta("not-checked"), selectable: false };
  }
  const status = runtimeStatus(runtime);
  return { status, selectable: SELECTABLE.has(status.key) };
}
