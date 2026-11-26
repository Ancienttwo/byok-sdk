import { cleanup, signal, Text, View } from "nsh";
import type { RolePreset } from "../../../../src/host/conversation/catalog.ts";
import type { BotProfile } from "../../../../src/host/store/types.ts";
import { toBridgeCallError } from "../../bridge.ts";
import { hostReady, k8View, reloadK8View, selectBot, selectedBotId } from "../../store.ts";
import { Button, Spinner } from "../../ui/index.ts";
import { BotRail } from "./BotRail.tsx";
import { Composer } from "./Composer.tsx";
import { ProfileEditor } from "./ProfileEditor.tsx";
import { Transcript } from "./Transcript.tsx";

type Editing = { readonly profile: BotProfile; readonly creating: boolean };

/** The conversation section: the Bot rail, the selected Bot's conversation and composer, and the profile editor. */
export function ConversationScreen() {
  const editing = signal<Editing | null>(null);
  // A Save or Archive reply can land after the rail replaced its editor or the section unmounted: it then changes nothing.
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const snapshot = () => k8View();
  const failure = () => {
    const error = k8View.error();
    return error === undefined ? null : toBridgeCallError(error).message;
  };
  const editingEntries = () => {
    const entry = editing();
    return entry === null ? [] : [entry];
  };
  const bot = () => snapshot()?.bots.find((row) => row.id === selectedBotId());
  // The shared resource keeps the last snapshot while the next Bot's read runs: show a conversation only under its Bot.
  const conversation = () => {
    const current = snapshot()?.conversation;
    return current !== undefined && current.botId === selectedBotId() ? current : undefined;
  };
  const startNew = (role: RolePreset, model: string) =>
    editing.set({
      creating: true,
      profile: { id: crypto.randomUUID(), name: role.label, role: role.role, persona: role.persona, model },
    });
  return (
    <View testID="conversation-section" class="gap-4">
      <If when={failure()}>
        <View role="alert" testID="conv-view-error" class="flex-row items-center gap-3">
          <Text class="text-sm text-destructive flex-1">{`Conversations unavailable: ${failure()}`}</Text>
          <Button testID="conv-view-retry" variant="outline" size="sm" onPress={reloadK8View}>
            Retry
          </Button>
        </View>
      </If>
      <If
        when={snapshot()}
        else={
          <If when={failure() === null}>
            <View class="flex-row items-center gap-2" accessibilityState={{ busy: true }}>
              <Spinner />
              <Text class="text-sm text-muted-foreground">
                {hostReady() ? "Loading conversations…" : "Conversations load once the Host runs."}
              </Text>
            </View>
          </If>
        }
      >
        {(loaded) => (
          <View class="flex-row gap-6">
            <BotRail
              bots={loaded().bots}
              roles={loaded().roles}
              selected={selectedBotId()}
              canCreate={loaded().models.length > 0}
              onSelect={(id) => {
                editing.set(null);
                selectBot(id);
              }}
              onNew={(role) => startNew(role, loaded().models[0].id)}
            />
            <View class="flex-1 gap-4">
              <Each of={editingEntries()} key={(entry) => entry.profile.id}>
                {(entry) => (
                  <ProfileEditor
                    initial={entry().profile}
                    creating={entry().creating}
                    models={loaded().models}
                    onDone={(saved) => {
                      if (!mounted || editing() !== entry()) {
                        return;
                      }
                      editing.set(null);
                      if (saved !== undefined) {
                        selectBot(saved);
                      }
                    }}
                  />
                )}
              </Each>
              <If when={editing() === null}>
                <If
                  when={bot()}
                  else={
                    <Text class="text-sm text-muted-foreground">
                      {loaded().bots.length === 0 ? 'No Bots yet. Create one with "New by role".' : "Select a Bot."}
                    </Text>
                  }
                >
                  {(selected) => (
                    <View class="gap-3">
                      <View class="flex-row items-center gap-3">
                        <Text role="header" accessibilityLevel={2} class="text-base font-semibold text-foreground">
                          {selected().name}
                        </Text>
                        <Text class="text-xs text-muted-foreground flex-1">{selected().role}</Text>
                        <If when={!selected().archived}>
                          <Button
                            testID="conv-edit-profile"
                            variant="outline"
                            size="sm"
                            onPress={() =>
                              editing.set({
                                creating: false,
                                profile: {
                                  id: selected().id,
                                  name: selected().name,
                                  role: selected().role,
                                  persona: selected().persona,
                                  model: selected().model,
                                },
                              })
                            }
                          >
                            Edit profile
                          </Button>
                        </If>
                      </View>
                      <If when={selected().archived}>
                        <Text class="text-xs text-muted-foreground">
                          This Bot is archived. Archiving is permanent; its conversation stays readable.
                        </Text>
                      </If>
                      <If
                        when={conversation()}
                        else={
                          <View class="flex-row items-center gap-2" accessibilityState={{ busy: true }}>
                            <Spinner />
                            <Text class="text-sm text-muted-foreground">Loading conversation…</Text>
                          </View>
                        }
                      >
                        {(current) => (
                          // Keyed by Bot: a new Bot gets a fresh composer, so a draft or pending send never carries over.
                          <Each of={[current().botId]} key={(id) => id}>
                            {() => (
                              <View class="gap-3">
                                <Transcript botId={current().botId} items={current().items} />
                                <Composer
                                  botId={current().botId}
                                  cancellable={current().cancellable}
                                  archived={selected().archived}
                                  hostRunning={hostReady()}
                                />
                              </View>
                            )}
                          </Each>
                        )}
                      </If>
                    </View>
                  )}
                </If>
              </If>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}
