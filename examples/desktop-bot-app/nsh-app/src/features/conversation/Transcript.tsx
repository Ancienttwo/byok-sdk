import { formatNumber, t } from "../../i18n.ts";
import { failureText } from "../../statusCopy.ts";
import { List, signal, Text, View } from "nsh";
import type { ConversationItem, TurnEnd } from "../../../../src/host/conversation/view.ts";
import { answerQuestion, historyUnfolded, setHistoryUnfolded } from "../../store.ts";
import { Button, Card, Input, MarkdownView, Separator, Surface } from "../../ui/index.ts";
import { createCommand } from "./command.ts";

type Item<K extends ConversationItem["kind"]> = Extract<ConversationItem, { kind: K }>;

const CONCLUSION_LABELS: Readonly<Record<string, string>> = {
  failed: "conversation.end.failed",
  cancelled: "conversation.end.cancelled",
  expired: "conversation.end.expired",
  declined: "conversation.end.declined",
  superseded: "conversation.end.superseded",
  no_reply: "conversation.end.no_reply",
};

/** A row the latest clear folds away; `clear`, `working` and `question` rows never fold. */
const isFolded = (item: ConversationItem) => "folded" in item && item.folded;

function endLabel(end: TurnEnd): string {
  if (end.backgroundUnavailable) {
    return t("conversation.backgroundUnavailable");
  }
  return t(Object.hasOwn(CONCLUSION_LABELS, end.conclusion) ? CONCLUSION_LABELS[end.conclusion]! : "conversation.end.other");
}

function InputRow(props: { item: () => Item<"input"> }) {
  return (
    <View class="items-end">
      <Surface tone="muted" class="px-3 py-2 max-w-xl">
        <View selectable>
          <Text class="text-sm text-foreground">{props.item().text}</Text>
        </View>
      </Surface>
    </View>
  );
}

function ReplyRow(props: { item: () => Item<"reply"> }) {
  return (
    <View class="items-start">
      <Surface class="px-3 py-2 max-w-xl">
        <MarkdownView testID={`conv-row-${props.item().key}`} markdown={props.item().text} selectable />
      </Surface>
    </View>
  );
}

function ClearRow() {
  return (
    <View class="gap-1 py-1">
      <Separator />
      <Text class="text-xs text-muted-foreground text-center">
        {t("conversation.cleared")}
      </Text>
    </View>
  );
}

function WorkingRow(props: { item: () => Item<"working"> }) {
  const draft = () => props.item().draft;
  const waitingText = () => {
    const reason = props.item().blocked;
    if (reason === undefined) return t("conversation.working");
    const detail = failureText(reason);
    return detail === undefined ? t("conversation.waiting") : t("conversation.waitingDetail", { reason: detail });
  };
  return (
    <View class="items-start gap-1" accessibilityState={{ busy: true }}>
      <Text class="text-xs text-muted-foreground">
        {waitingText()}
      </Text>
      <If when={draft()}>
        {(current) => (
          <Surface class="px-3 py-2 max-w-xl">
            <MarkdownView
              testID={`conv-draft-${props.item().turnId}`}
              markdown={current().text}
              streaming
              streamingCaret
            />
          </Surface>
        )}
      </If>
      <If when={draft()?.state === "gap"}>
        <Text class="text-xs text-muted-foreground">{t("conversation.draftGap")}</Text>
      </If>
      <If when={draft()?.state === "overflow"}>
        <Text class="text-xs text-muted-foreground">{t("conversation.draftOverflow")}</Text>
      </If>
      <If when={draft()?.state === "failed"}>
        <Text class="text-xs text-destructive">{t("conversation.draftFailed")}</Text>
      </If>
    </View>
  );
}

function EndedRow(props: { item: () => Item<"ended"> }) {
  const detail = () => failureText(props.item().end.reason);
  return (
    <Surface tone="muted" class="px-3 py-2 gap-1">
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={endLabel(props.item().end)}>
        <View class="flex-row gap-2">
          <Text class="text-sm text-foreground">{props.item().end.conclusion === "failed" ? "✕" : "○"}</Text>
          <Text class="text-sm font-semibold text-foreground flex-1">{endLabel(props.item().end)}</Text>
        </View>
      </View>
      <If when={detail()}>
        <Text class="text-xs text-muted-foreground">{detail()}</Text>
      </If>
    </Surface>
  );
}

function QuestionRow(props: { item: () => Item<"question"> }) {
  const answer = signal("");
  const command = createCommand();
  const question = () => props.item().question;
  const options = () => {
    const current = question();
    return current.answerKind === "single_choice" ? current.options : [];
  };
  const submit = (value: string) => void command.run(() => answerQuestion(props.item().id, value));
  return (
    <Card>
      <Text class="text-sm text-foreground">{question().question}</Text>
      <If
        when={props.item().answer === undefined}
        else={<Text class="text-xs text-muted-foreground">{t("conversation.answered", { answer: props.item().answer ?? "" })}</Text>}
      >
        <If
          when={question().answerKind === "single_choice"}
          else={
            <View class="flex-row items-center gap-2">
              <View class="flex-1">
                <Input
                  testID={`conv-answer-${props.item().id}`}
                  accessibilityLabel={t("conversation.answerLabel", { question: question().question })}
                  value={answer()}
                  onChange={(e) => answer.set(e.value)}
                  onSubmit={() => {
                    if (answer() !== "" && !command.busy()) {
                      submit(answer());
                    }
                  }}
                />
              </View>
              <Button
                testID={`conv-answer-${props.item().id}-submit`}
                loading={command.busy()}
                disabled={answer() === ""}
                onPress={() => submit(answer())}
              >
                {t("conversation.answer")}
              </Button>
            </View>
          }
        >
          <View class="flex-row flex-wrap items-center gap-2">
            <Each of={options()} key={(option) => option.id}>
              {(option) => (
                <Button
                  testID={`conv-answer-${props.item().id}-${option().id}`}
                  variant="outline"
                  disabled={command.busy()}
                  onPress={() => submit(option().id)}
                >
                  {option().label}
                </Button>
              )}
            </Each>
          </View>
        </If>
      </If>
      <If when={command.error()}>
        <View role="alert">
          <Text class="text-xs text-destructive">{command.error()}</Text>
        </View>
      </If>
    </Card>
  );
}

/** One mounted row: its branch is chosen once, and it reads `item()` as the same key and kind update (a streaming draft). */
function RowFor(props: { item: () => ConversationItem }) {
  switch (props.item().kind) {
    case "input":
      return <InputRow item={props.item as () => Item<"input">} />;
    case "reply":
      return <ReplyRow item={props.item as () => Item<"reply">} />;
    case "clear":
      return <ClearRow />;
    case "working":
      return <WorkingRow item={props.item as () => Item<"working">} />;
    case "ended":
      return <EndedRow item={props.item as () => Item<"ended">} />;
    case "question":
      return <QuestionRow item={props.item as () => Item<"question">} />;
  }
}

/** The conversation; rows above the latest clear fold behind one toggle (per Bot, in the store) and stay. */
export function Transcript(props: { botId: string; items: readonly ConversationItem[] }) {
  const folded = () => props.items.filter(isFolded).length;
  const unfolded = () => historyUnfolded(props.botId);
  const visible = () => (unfolded() ? props.items : props.items.filter((item) => !isFolded(item)));
  return (
    <View class="gap-2">
      <If when={folded() > 0}>
        <Button
          testID="conv-fold-toggle"
          variant="ghost"
          size="sm"
          accessibilityHint={unfolded() ? t("conversation.hideEarlierHint") : t("conversation.showEarlierHint")}
          onPress={() => setHistoryUnfolded(props.botId, !unfolded())}
        >
          {t(unfolded() ? "conversation.hideEarlier" : "conversation.showEarlier", { count: formatNumber(folded()) })}
        </Button>
      </If>
      <List
        testID="conv-transcript"
        role="list"
        accessibilityLabel={t("section.conversation")}
        class="h-96"
        contentClass="gap-3 p-1"
        each={visible()}
        keyExtractor={(item) => item.key}
        estimatedItemSize={64}
        alignment="bottom"
        initialScrollAtEnd
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}
        empty={<Text class="text-sm text-muted-foreground">{t("conversation.noMessages")}</Text>}
      >
        {(item) => (
          // A List cell outlives its item: scrolling recycles it for another key, and the Host keeps `t<turnId>` when a
          // working Turn ends. Mounting per key and kind gives each row its own renderer and local state.
          <Each of={[item()]} key={(current) => `${current.key}:${current.kind}`}>
            {(current) => <RowFor item={current} />}
          </Each>
        )}
      </List>
    </View>
  );
}
