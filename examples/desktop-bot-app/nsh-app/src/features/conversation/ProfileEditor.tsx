import { signal, Text, View } from "nsh";
import type { ModelChoice } from "../../../../src/host/conversation/catalog.ts";
import type { BotProfile } from "../../../../src/host/store/types.ts";
import { archiveBot, saveBot } from "../../store.ts";
import { Button, Card, Dialog, Field, Input, Select, Textarea } from "../../ui/index.ts";
import { createCommand } from "./command.ts";

export interface ProfileEditorProps {
  initial: BotProfile;
  creating: boolean;
  models: readonly ModelChoice[];
  /** The saved or archived Bot's id; undefined when closed without a change. */
  onDone: (saved: string | undefined) => void;
}

/**
 * Creates or edits a Bot. The id comes with `initial` and stays, so a retried Save is the same command to the Host.
 * Archive is irreversible (K8 never takes an archived Bot back), so it asks once more and says so; the Bot's home and
 * transcript stay.
 */
export function ProfileEditor(props: ProfileEditorProps) {
  const profile = signal<BotProfile>(props.initial);
  const confirmArchive = signal(false);
  const command = createCommand();
  const edit = (patch: Partial<BotProfile>) => profile.update((current) => ({ ...current, ...patch }));
  const complete = () => {
    const current = profile();
    return current.name !== "" && current.role !== "" && current.persona !== "" && current.model !== "";
  };
  const save = async () => {
    const current = profile();
    if (await command.run(() => saveBot(current))) {
      props.onDone(current.id);
    }
  };
  const archive = async () => {
    const id = profile().id;
    if (await command.run(() => archiveBot(id))) {
      confirmArchive.set(false);
      props.onDone(id);
    }
  };
  return (
    <Card>
      <View testID="conv-profile" class="gap-4">
        <Text role="header" accessibilityLevel={2} class="text-base font-semibold text-foreground">
          {props.creating ? "New Bot" : "Edit profile"}
        </Text>
        <Field label="Name" required>
          <Input
            testID="conv-profile-name"
            accessibilityLabel="Name"
            value={profile().name}
            onChange={(e) => edit({ name: e.value })}
          />
        </Field>
        <Field label="Role" required>
          <Input
            testID="conv-profile-role"
            accessibilityLabel="Role"
            value={profile().role}
            onChange={(e) => edit({ role: e.value })}
          />
        </Field>
        <Field label="Persona" required>
          <Textarea
            testID="conv-profile-persona"
            accessibilityLabel="Persona"
            value={profile().persona}
            onChange={(e) => edit({ persona: e.value })}
          />
        </Field>
        <Field label="Model" required>
          <Select
            testID="conv-profile-model"
            accessibilityLabel="Model"
            items={props.models.map((model) => ({ value: model.id, title: model.label }))}
            value={profile().model}
            onChange={(value) => {
              if (value !== null) {
                edit({ model: value });
              }
            }}
          />
        </Field>
        <If when={command.error() !== null && !confirmArchive()}>
          <View role="alert" testID="conv-profile-error">
            <Text class="text-xs text-destructive">{command.error()}</Text>
          </View>
        </If>
        <View class="flex-row items-center gap-2">
          <Button
            testID="conv-profile-save"
            loading={command.busy() && !confirmArchive()}
            disabled={command.busy() || !complete()}
            onPress={() => void save()}
          >
            Save
          </Button>
          <Button
            testID="conv-profile-close"
            variant="outline"
            disabled={command.busy()}
            onPress={() => props.onDone(undefined)}
          >
            Close
          </Button>
          <If when={!props.creating}>
            <Button
              testID="conv-profile-archive"
              variant="danger"
              disabled={command.busy()}
              onPress={() => confirmArchive.set(true)}
            >
              Archive…
            </Button>
          </If>
        </View>
      </View>
      <Dialog
        testID="conv-archive-dialog"
        role="alertdialog"
        open={confirmArchive()}
        title="Archive Bot"
        description="Archiving is permanent: this Bot takes no new work and cannot be restored. Its conversation and home stay readable."
        onOpenChange={(open) => {
          if (!command.busy()) {
            confirmArchive.set(open);
          }
        }}
        footer={
          <View class="flex-row items-center gap-2">
            <Button
              testID="conv-archive-keep"
              variant="outline"
              disabled={command.busy()}
              onPress={() => confirmArchive.set(false)}
            >
              Keep Bot
            </Button>
            <Button
              testID="conv-archive-confirm"
              variant="danger"
              loading={command.busy()}
              disabled={command.busy()}
              onPress={() => void archive()}
            >
              Archive permanently
            </Button>
          </View>
        }
      >
        <If when={command.error()}>
          <View role="alert" testID="conv-archive-error">
            <Text class="text-xs text-destructive">{command.error()}</Text>
          </View>
        </If>
      </Dialog>
    </Card>
  );
}
