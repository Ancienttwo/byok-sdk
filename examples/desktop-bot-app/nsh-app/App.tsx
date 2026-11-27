import { cleanup, effect, mount, platform, Scroll, signal, Text, View } from "nsh";
import { currentWindow, isAvailable } from "nsh/desktop";
import brand from "../brand.config.ts";
import { fitFirstWindow, installDesktopShell, syncDesktopChrome } from "./src/desktop.ts";
import { ActivityScreen } from "./src/features/activity/ActivityScreen.tsx";
import { ConversationScreen } from "./src/features/conversation/ConversationScreen.tsx";
import { GalleryScreen } from "./src/features/gallery/GalleryScreen.tsx";
import { KeysScreen } from "./src/features/keys/KeysScreen.tsx";
import { SettingsScreen } from "./src/features/settings/SettingsScreen.tsx";
import { RecoveryPanel } from "./src/features/shell/RecoveryPanel.tsx";
import { ShellSidebar } from "./src/features/shell/ShellSidebar.tsx";
import {
  activeSection,
  appearance,
  connectShell,
  hostState,
  isQuitting,
  isRecoveryBusy,
  powerError,
  requestQuit,
  restartHost,
  setActiveSection,
  setAppearance,
  shellStart,
  showMainWindow,
  startShell,
  stateHintCount,
  type WorkspaceSection,
} from "./src/store.ts";
import { Card, ToastRegion, type ToastNotice } from "./src/ui/index.ts";

const SECTION_TITLES: Record<WorkspaceSection, string> = {
  conversation: "Conversation",
  activity: "Activity",
  settings: "Settings",
  keys: "Keys",
  // The Gallery exists only in development builds: a release build folds this to "" and drops the title text.
  gallery: process.env.NODE_ENV !== "production" ? "Foundations Gallery" : "",
};

export function App() {
  const win = isAvailable ? currentWindow() : null;
  if (win) {
    fitFirstWindow(win);
  }

  effect(() => {
    if (win) {
      win.set({
        title: `${brand.productName} — ${SECTION_TITLES[activeSection()]}`,
      });
    }
  });

  effect(() => {
    const disconnect = connectShell();
    cleanup(disconnect);
    void startShell();
  });

  effect(() => {
    const stopDesktop = installDesktopShell(win);
    cleanup(stopDesktop);
  });

  effect(() => {
    syncDesktopChrome({
      host: hostState(),
      start: shellStart(),
      quitting: isQuitting(),
      recoveryBusy: isRecoveryBusy(),
      activeSection: activeSection(),
      appearance: appearance(),
      onShow: showMainWindow,
      onRestartHost: () => void restartHost(),
      onQuit: requestQuit,
      onSelectSection: setActiveSection,
      onSelectAppearance: setAppearance,
    });
  });

  const notices = signal<ToastNotice[]>([]);

  const pushToast = (tone: ToastNotice["tone"], title: string, description?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    notices.update((list) => [...list.slice(-3), { id, tone, title, description }]);
  };

  const dismissToast = (id: string) => {
    notices.update((list) => list.filter((item) => item.id !== id));
  };

  return (
    <View class="flex-1 bg-background">
      <View class="flex-row flex-1">
        <ShellSidebar />
        <Scroll class="flex-1" contentClass="p-6 gap-6 max-w-5xl w-full self-center">
          {/* Header Bar */}
          <Card>
            <View class="gap-1">
              <Text role="header" accessibilityLevel={1} class="text-lg font-semibold text-foreground">
                {`${brand.productName} — ${SECTION_TITLES[activeSection()]}`}
              </Text>
              <Text class="text-xs text-muted-foreground">
                {`Platform: ${platform.os} • Hints: ${stateHintCount()} • Quitting: ${isQuitting() ? "yes" : "no"}`}
              </Text>
            </View>
            <If when={Boolean(powerError())}>
              <Text class="text-xs text-warning">{`Power save notice: ${powerError()}`}</Text>
            </If>
          </Card>

          <RecoveryPanel />

          <If when={activeSection() === "keys"}>
            <KeysScreen onNotify={pushToast} />
          </If>

          <If when={activeSection() === "settings"}>
            <SettingsScreen />
          </If>

          <If when={activeSection() === "conversation"}>
            <ConversationScreen />
          </If>

          <If when={activeSection() === "activity"}>
            <ActivityScreen />
          </If>

          {process.env.NODE_ENV !== "production" ? (
            <If when={activeSection() === "gallery"}>
              <GalleryScreen onNotify={pushToast} />
            </If>
          ) : null}
        </Scroll>
      </View>

      <ToastRegion
        notices={notices()}
        onDismiss={dismissToast}
        onClearAll={() => notices.set([])}
      />
    </View>
  );
}

mount(() => <App />);
