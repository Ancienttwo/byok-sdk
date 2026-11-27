import { Text, View } from "nsh";
import type { BotMemory } from "../../../../src/host/conversation/types.ts";
import { toBridgeCallError } from "../../bridge.ts";
import { botMemory, reloadBotMemory } from "../../store.ts";
import { Button, Spinner } from "../../ui/index.ts";

type MemoryRead =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "ready"; readonly memory: BotMemory };

/** The store's `k8.memory` read as seen by `botId`: another Bot's last value still loads for this one. */
function memoryRead(botId: string): MemoryRead {
  const value = botMemory();
  const ready: MemoryRead | undefined = value !== undefined && value.botId === botId ? { state: "ready", memory: value.memory } : undefined;
  if (botMemory.loading()) {
    return ready ?? { state: "loading" };
  }
  const error = botMemory.error();
  if (error !== undefined) {
    return { state: "failed", message: toBridgeCallError(error).message };
  }
  return ready ?? { state: "loading" };
}

/** Bytes as B below one KiB, else KiB with at most one decimal. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
}

const OUTCOME_LABELS: Readonly<Record<NonNullable<BotMemory["lastDream"]>["outcome"], string>> = {
  succeeded: "Succeeded",
  skipped: "Skipped",
  failed: "Failed",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  superseded: "Superseded",
};

const overLimitText = (resident: NonNullable<BotMemory["resident"]>) =>
  `▲ MEMORY.md is over the ${formatBytes(resident.limitBytes)} limit (${resident.byteCount} bytes): tasks fail before they start until it is back within the limit.`;

function residentText(resident: BotMemory["resident"]): string {
  return resident === null ? "Unavailable" : `${formatBytes(resident.byteCount)} of ${formatBytes(resident.limitBytes)}`;
}

function notesText(notes: BotMemory["notes"]): string {
  return notes === null ? "Unavailable" : `${notes.count} ${notes.count === 1 ? "file" : "files"} · ${formatBytes(notes.bytes)}`;
}

function lastDreamText(dream: BotMemory["lastDream"]): string {
  if (dream === null) {
    return "No dream yet";
  }
  const reason = dream.reason === undefined ? "" : ` (${dream.reason.replaceAll("_", " ")})`;
  const model = dream.template === undefined ? "" : ` · ${dream.template}${dream.fallback ? ", the Bot's own model" : ""}`;
  return `${OUTCOME_LABELS[dream.outcome]}${reason} · ${new Date(dream.at).toLocaleString()}${model}`;
}

function Row(props: { label: string; value: string; testID: string }) {
  return (
    <View class="flex-row gap-3">
      <Text class="text-xs text-muted-foreground w-40">{props.label}</Text>
      <Text testID={props.testID} class="text-xs text-foreground flex-1">
        {props.value}
      </Text>
    </View>
  );
}

/** The Memory tab of a Bot's profile: `MEMORY.md` against its limit, the notes, and the last and next dream. */
export function BotMemoryPanel(props: { botId: string }) {
  const read = () => memoryRead(props.botId);
  const ready = () => {
    const current = read();
    return current.state === "ready" ? current.memory : undefined;
  };
  const failure = () => {
    const current = read();
    return current.state === "failed" ? current.message : null;
  };
  return (
    <View testID="conv-memory" class="gap-3">
      <If when={failure()}>
        <View role="alert" testID="conv-memory-error" class="flex-row items-center gap-3">
          <Text class="text-sm text-destructive flex-1">{`Memory unavailable: ${failure()}`}</Text>
          <Button testID="conv-memory-retry" variant="outline" size="sm" onPress={reloadBotMemory}>
            Retry
          </Button>
        </View>
      </If>
      <If
        when={ready()}
        else={
          <If when={failure() === null}>
            <View class="flex-row items-center gap-2" accessibilityState={{ busy: true }}>
              <Spinner />
              <Text class="text-sm text-muted-foreground">Loading memory…</Text>
            </View>
          </If>
        }
      >
        {(memory) => (
          <View class="gap-2">
            <Row testID="conv-memory-resident" label="Resident memory" value={residentText(memory().resident)} />
            <If when={memory().resident?.overLimit === true ? memory().resident : undefined}>
              {(resident) => (
                <View role="alert" testID="conv-memory-over-limit">
                  <Text class="text-xs text-destructive">{overLimitText(resident())}</Text>
                </View>
              )}
            </If>
            <Row testID="conv-memory-notes" label="Notes" value={notesText(memory().notes)} />
            <Row testID="conv-memory-last-dream" label="Last dream" value={lastDreamText(memory().lastDream)} />
            <Row testID="conv-memory-next-dream" label="Next dream" value="Unavailable" />
          </View>
        )}
      </If>
    </View>
  );
}

/** The one-line Memory summary under the selected Bot's header. */
export function BotMemorySummary(props: { botId: string }) {
  const summary = () => {
    const current = memoryRead(props.botId);
    if (current.state === "loading") {
      return { text: "Memory: loading…", alert: false };
    }
    if (current.state === "failed" || current.memory.resident === null) {
      return { text: "Memory: unavailable", alert: false };
    }
    const { resident, notes } = current.memory;
    const notesPart = notes === null ? "" : ` · ${notes.count} ${notes.count === 1 ? "note" : "notes"}`;
    return resident.overLimit
      ? { text: `▲ Memory over limit: ${residentText(resident)}, tasks fail before they start`, alert: true }
      : { text: `Memory: ${residentText(resident)}${notesPart}`, alert: false };
  };
  return (
    <View testID="conv-memory-summary" role={summary().alert ? "alert" : undefined}>
      <Text class={summary().alert ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{summary().text}</Text>
    </View>
  );
}
