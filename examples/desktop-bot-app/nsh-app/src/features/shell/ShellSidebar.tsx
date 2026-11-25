import { signal, Text, View } from "nsh";
import brand from "../../../../brand.config.ts";
import {
  activeSection,
  appearance,
  describeHostState,
  hostState,
  isQuitting,
  isRecoveryBusy,
  previewHostState,
  requestQuit,
  restartHost,
  setActiveSection,
  setAppearance,
  type WorkspaceSection,
} from "../../store.ts";
import { Button, HostStateBadge, ListItem, Separator, Tab, Tabs } from "../../ui/index.ts";

interface NavItem {
  readonly id: WorkspaceSection;
  readonly label: string;
}

const PRIMARY_SECTIONS: readonly NavItem[] = [
  { id: "conversation", label: "Conversation" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
  { id: "keys", label: "Keys" },
];

/** Persistent desktop sidebar owning section selection, live Host status, appearance, and Quit. */
export function ShellSidebar() {
  const restarting = signal(false);

  // The Gallery exists only in development builds (App.tsx); a release build folds this to hostState().
  const badgeState = () =>
    process.env.NODE_ENV !== "production" && activeSection() === "gallery"
      ? (previewHostState() ?? hostState())
      : hostState();

  const canRestartHost = () => {
    const state = hostState()?.state;
    return state === "stopped" || state === "failed";
  };

  const handleRestartHost = () => {
    if (restarting() || isQuitting() || isRecoveryBusy()) {
      return;
    }
    restarting.set(true);
    void restartHost().finally(() => {
      restarting.set(false);
    });
  };

  return (
    <View class="w-56 bg-sidebar border-r border-sidebar-border p-3 justify-between gap-4">
      <View class="gap-3">
        <View class="px-2 py-1 gap-0.5">
          <Text class="text-sm font-semibold text-sidebar-foreground">{brand.productName}</Text>
          <Text class="text-xs text-muted-foreground">Desktop Workspace</Text>
        </View>
        <View role="navigation" accessibilityLabel="Workspace sections" class="gap-1">
          {PRIMARY_SECTIONS.map((item) => (
            <ListItem
              testID={`nav-${item.id}`}
              title={item.label}
              selected={activeSection() === item.id}
              onPress={() => setActiveSection(item.id)}
            />
          ))}
        </View>
        {process.env.NODE_ENV !== "production" ? (
          <View class="gap-3">
            <Separator />
            <ListItem
              testID="nav-gallery"
              title="Foundations Gallery"
              selected={activeSection() === "gallery"}
              onPress={() => setActiveSection("gallery")}
            />
          </View>
        ) : null}
      </View>

      <View class="gap-3 pt-3 border-t border-sidebar-border">
        <View class="gap-1.5">
          <HostStateBadge testID="host-state-badge" state={badgeState()} />
          <Text testID="sidebar-host-status" class="text-xs text-muted-foreground">
            {describeHostState(hostState())}
          </Text>
        </View>
        <If when={canRestartHost()}>
          <Button
            testID="sidebar-restart-host"
            variant="secondary"
            size="sm"
            loading={restarting()}
            disabled={restarting() || isQuitting() || isRecoveryBusy()}
            onPress={handleRestartHost}
          >
            Restart Host
          </Button>
        </If>
        <Tabs testID="appearance-tabs" accessibilityLabel="Appearance mode">
          <Tab
            testID="theme-light"
            selected={appearance() === "light"}
            onPress={() => setAppearance("light")}
          >
            Light
          </Tab>
          <Tab
            testID="theme-dark"
            selected={appearance() === "dark"}
            onPress={() => setAppearance("dark")}
          >
            Dark
          </Tab>
          <Tab
            testID="theme-system"
            selected={appearance() === "system"}
            onPress={() => setAppearance("system")}
          >
            System
          </Tab>
        </Tabs>
        <Button
          testID="quit-app-btn"
          variant="outline"
          size="sm"
          disabled={isQuitting()}
          onPress={requestQuit}
        >
          {isQuitting() ? "Quitting…" : "Quit"}
        </Button>
      </View>
    </View>
  );
}
