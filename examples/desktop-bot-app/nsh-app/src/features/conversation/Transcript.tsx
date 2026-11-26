import { List, signal, Text, View } from "nsh";
import type { ConversationItem, TurnEnd } from "../../../../src/host/conversation/view.ts";
import { answerQuestion, historyUnfolded, setHistoryUnfolded } from "../../store.ts";
import { Button, Card, Input, MarkdownView, Separator, Surface } from "../../ui/index.ts";
import { createCommand } from "./command.ts";

type Item<K extends ConversationItem["kind"]> = Extract<ConversationItem, { kind: K }>;

const CONCLUSION_LABEL: Readonly<Record<string, string>> = {
  failed: "Turn failed",
  cancelled: "Turn cancelled",
  expired: "Turn expired",
  no_reply: "Turn ended without a reply",
};

/** A row the latest clear folds away; `clear`, `working` and `question` rows never fold. */
const isFolded = (item: ConversationItem) => "folded" in item && item.folded;

function endLabel(end: TurnEnd): string {
  if (end.backgroundUnavailable) {
    return "Turn failed: background Pi work is not available in this app";
  }
  return CONCLUSION_LABEL[end.conclusion] ?? `Turn ended: ${end.conclusion}`;
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
        Context cleared: the Bot no longer sees the messages above
      </Text>
    </View>
  );
}

function WorkingRow(props: { item: () => Item<"working"> }) {
  const draft = () => props.item().draft;
  return (
    <View class="items-start gap-1" accessibilityState={{ busy: true }}>
      <Text class="text-xs text-muted-foreground">
        {props.item().blocked === undefined ? "Working…" : `Waiting: ${props.item().blocked}`}
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
        <Text class="text-xs text-muted-foreground">Part of the draft was lost; the accepted reply will be complete.</Text>
      </If>
      <If when={draft()?.state === "overflow"}>
        <Text class="text-xs text-muted-foreground">The draft is too long to show; the accepted reply will follow.</Text>
      </If>
      <If when={draft()?.state === "failed"}>
        <Text class="text-xs text-destructive">{`Draft unavailable${draft()?.error === undefined ? "" : `: ${draft()?.error}`}`}</Text>
      </If>
    </View>
  );
}

function EndedRow(props: { item: () => Item<"ended"> }) {
  return (
    <Surface tone="muted" class="px-3 py-2 gap-1">
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={endLabel(props.item().end)}>
        <Text class="text-sm font-semibold text-foreground">{endLabel(props.item().end)}</Text>
      </View>
      <If when={props.item().end.reason !== undefined}>
        <Text class="text-xs text-muted-foreground">{props.item().end.reason}</Text>
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
        else={<Text class="text-xs text-muted-foreground">{`Answered: ${props.item().answer}`}</Text>}
      >
        <If
          when={question().answerKind === "single_choice"}
          else={
            <View class="flex-row items-center gap-2">
              <View class="flex-1">
                <Input
                  testID={`conv-answer-${props.item().id}`}
                  accessibilityLabel={`Answer: ${question().question}`}
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
                Answer
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
          accessibilityHint={unfolded() ? "Hides the messages above the latest clear" : "Shows the messages above the latest clear"}
          onPress={() => setHistoryUnfolded(props.botId, !unfolded())}
        >
          {`${unfolded() ? "Hide" : "Show"} ${folded()} earlier messages`}
        </Button>
      </If>
      <List
        testID="conv-transcript"
        role="list"
        accessibilityLabel="Conversation"
        class="h-96"
        contentClass="gap-3 p-1"
        each={visible()}
        keyExtractor={(item) => item.key}
        estimatedItemSize={64}
        alignment="bottom"
        initialScrollAtEnd
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}
        empty={<Text class="text-sm text-muted-foreground">No messages yet.</Text>}
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
