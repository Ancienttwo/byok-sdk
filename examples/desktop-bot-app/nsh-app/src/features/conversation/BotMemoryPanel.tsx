import { formatDate, formatNumber, t } from "../../i18n.ts";
import { Text, View } from "nsh";
import type { BotMemory } from "../../../../src/host/conversation/types.ts";
import { bridgeErrorText } from "../../statusCopy.ts";
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
    return { state: "failed", message: bridgeErrorText(error) };
  }
  return ready ?? { state: "loading" };
}

/** Bytes as B below one KiB, else KiB with at most one decimal. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return t("memory.bytes", { size: formatNumber(bytes) });
  return t("memory.kib", { size: formatNumber(bytes / 1024, { maximumFractionDigits: 1 }) });
}

const overLimitText = (resident: NonNullable<BotMemory["resident"]>) =>
  t("memory.overLimit", { limit: formatBytes(resident.limitBytes), used: t("memory.bytes", { size: formatNumber(resident.byteCount) }) });

function residentText(resident: BotMemory["resident"]): string {
  return resident === null
    ? t("common.unavailable")
    : t("memory.position", { used: formatBytes(resident.byteCount), limit: formatBytes(resident.limitBytes) });
}

function notesText(notes: BotMemory["notes"]): string {
  return notes === null
    ? t("common.unavailable")
    : t("memory.fileCount", { count: formatNumber(notes.count), size: formatBytes(notes.bytes) });
}

function lastDreamText(dream: BotMemory["lastDream"]): string {
  if (dream === null) return t("memory.noDream");
  const outcome = t(`memory.outcome.${dream.outcome}`);
  const status = dream.reason === undefined
    ? outcome
    : t("memory.dreamReason", { status: outcome, reason: t(`memory.reason.${dream.reason}`) });
  const summary = t("memory.dream", { status, at: formatDate(dream.at) });
  return dream.template === undefined
    ? summary
    : t(dream.fallback ? "memory.dreamFallback" : "memory.dreamModel", { dream: summary, model: dream.template });
}

function Row(props: { label: string; value: string; testID: string }) {
  return (
    <View class="flex-row gap-3">
      <Text class="text-xs text-muted-foreground basis-1/3 min-w-0">{props.label}</Text>
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
          <Text class="text-sm text-destructive flex-1">{t("memory.error", { error: failure() ?? "" })}</Text>
          <Button testID="conv-memory-retry" variant="outline" size="sm" onPress={reloadBotMemory}>
            {t("common.retry")}
          </Button>
        </View>
      </If>
      <If
        when={ready()}
        else={
          <If when={failure() === null}>
            <View class="flex-row items-center gap-2" accessibilityState={{ busy: true }}>
              <Spinner />
              <Text class="text-sm text-muted-foreground">{t("memory.loading")}</Text>
            </View>
          </If>
        }
      >
        {(memory) => (
          <View class="gap-2">
            <Row testID="conv-memory-resident" label={t("memory.resident")} value={residentText(memory().resident)} />
            <If when={memory().resident?.overLimit === true ? memory().resident : undefined}>
              {(resident) => (
                <View role="alert" testID="conv-memory-over-limit">
                  <Text class="text-xs text-destructive">{overLimitText(resident())}</Text>
                </View>
              )}
            </If>
            <Row testID="conv-memory-notes" label={t("memory.notes")} value={notesText(memory().notes)} />
            <Row testID="conv-memory-last-dream" label={t("memory.lastDream")} value={lastDreamText(memory().lastDream)} />
            <Row testID="conv-memory-next-dream" label={t("memory.nextDream")} value={t("common.unavailable")} />
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
      return { text: t("memory.summaryLoading"), alert: false };
    }
    if (current.state === "failed" || current.memory.resident === null) {
      return { text: t("memory.summaryUnavailable"), alert: false };
    }
    const { resident, notes } = current.memory;
    const used = residentText(resident);
    if (resident.overLimit) {
      return { text: t("memory.summaryOverLimit", { resident: used }), alert: true };
    }
    const text = notes === null
      ? t("memory.summary", { resident: used })
      : t("memory.summaryWithNotes", { resident: used, count: formatNumber(notes.count) });
    return { text, alert: false };
  };
  return (
    <View testID="conv-memory-summary" role={summary().alert ? "alert" : undefined}>
      <Text class={summary().alert ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{summary().text}</Text>
    </View>
  );
}
