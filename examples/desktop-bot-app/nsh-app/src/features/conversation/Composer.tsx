import { signal, Text, View } from "nsh";
import { cancelTurn, clearContext, sendMessage } from "../../store.ts";
import { Button, Textarea } from "../../ui/index.ts";
import { createCommand } from "./command.ts";

export interface ComposerProps {
  botId: string;
  /** Open Turns, oldest first: the oldest is the one running, later ones wait behind it. */
  cancellable: readonly string[];
  /** The Bot is archived. */
  archived: boolean;
  /** The Host runs: commands can reach it. */
  hostRunning: boolean;
}

/**
 * Send, cancel and clear for one Bot. A send keeps its action id until it succeeds, so a retry of the same text is the
 * same command to the Host; editing the text starts a new one.
 */
export function Composer(props: ComposerProps) {
  const text = signal("");
  const pending = signal<{ actionId: string; text: string } | null>(null);
  const command = createCommand();
  const disabled = () => props.archived || !props.hostRunning;
  const send = async () => {
    const current = pending();
    const action = current !== null && current.text === text() ? current : { actionId: crypto.randomUUID(), text: text() };
    pending.set(action);
    const sent = await command.run(() =>
      sendMessage({ actionId: action.actionId, botId: props.botId, text: action.text }),
    );
    if (sent) {
      pending.set(null);
      text.set("");
    }
  };
  const trySend = () => {
    if (text() !== "" && !command.busy() && !disabled()) {
      void send();
    }
  };
  const placeholder = () =>
    props.archived ? "This Bot is archived" : props.hostRunning ? "Message" : "The Host is not running";
  return (
    <View class="gap-2">
      <Textarea
        testID="conv-composer-input"
        accessibilityLabel="Message"
        placeholder={placeholder()}
        value={text()}
        disabled={disabled()}
        submitBehavior="submit"
        onChange={(e) => text.set(e.value)}
        onSubmit={trySend}
      />
      <If when={command.error()}>
        <View role="alert" testID="conv-composer-error">
          <Text class="text-xs text-destructive">{command.error()}</Text>
        </View>
      </If>
      <View class="flex-row items-center gap-2">
        <Button
          testID="conv-send"
          loading={command.busy()}
          disabled={disabled() || text() === ""}
          accessibilityHint="Enter sends; Shift+Enter starts a new line"
          onPress={trySend}
        >
          Send
        </Button>
        <Button
          testID="conv-cancel-turn"
          variant="outline"
          disabled={command.busy() || !props.hostRunning || props.cancellable.length === 0}
          onPress={() => {
            const turnId = props.cancellable[0];
            void command.run(() => cancelTurn(turnId));
          }}
        >
          Cancel Turn
        </Button>
        <Button
          testID="conv-clear"
          variant="outline"
          disabled={command.busy() || disabled()}
          onPress={() => void command.run(() => clearContext({ actionId: crypto.randomUUID(), botId: props.botId }))}
        >
          Clear context
        </Button>
      </View>
    </View>
  );
}
