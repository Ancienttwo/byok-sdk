import { formatNumber, loadLanguagePreference, t } from "./src/i18n.ts";
import { cleanup, effect, mount, platform, resource, Scroll, signal, Text, View } from "nsh";
import { currentWindow, isAvailable } from "nsh/desktop";
import brand from "../brand.config.ts";
import { fitFirstWindow, installDesktopShell, syncDesktopChrome } from "./src/desktop.ts";
import { ActivityScreen } from "./src/features/activity/ActivityScreen.tsx";
import { ConversationScreen } from "./src/features/conversation/ConversationScreen.tsx";
import { GalleryScreen, loadGalleryTranslations } from "./src/features/gallery/GalleryScreen.tsx";
import { KeysScreen } from "./src/features/keys/KeysScreen.tsx";
import { OnboardingScreen } from "./src/features/onboarding/OnboardingScreen.tsx";
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
  onboardingPending,
  powerError,
  requestQuit,
  restartHost,
  setActiveSection,
  setAppearance,
  shellStart,
  showMainWindow,
  showOnboarding,
  startShell,
  stateHintCount,
  type WorkspaceSection,
} from "./src/store.ts";
import { Card, Spinner, ToastRegion, type ToastNotice } from "./src/ui/index.ts";

function sectionTitle(section: WorkspaceSection): string {
  if (section === "gallery") return process.env.NODE_ENV !== "production" ? t("gallery.title") : "";
  return t("section." + section);
}

const windowTitle = () => t("app.title", { product: brand.productName, section: sectionTitle(activeSection()) });

export function App() {
  if (process.env.NODE_ENV !== "production") loadGalleryTranslations();
  const language = resource(() => true, loadLanguagePreference);
  const win = isAvailable ? currentWindow() : null;
  if (win) {
    fitFirstWindow(win);
  }

  effect(() => {
    if (win) {
      win.set({
        title: windowTitle(),
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

  const pushToast = (tone: ToastNotice["tone"], title: ToastNotice["title"], description?: ToastNotice["description"]) => {
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
                {windowTitle()}
              </Text>
              <Text class="text-xs text-muted-foreground">
                {t("app.info", { platform: platform.os, hints: formatNumber(stateHintCount()), quitting: t(isQuitting() ? "common.yes" : "common.no") })}
              </Text>
            </View>
            <If when={Boolean(powerError())}>
              <Text class="text-xs text-warning">{t("host.powerNotice")}</Text>
            </If>
          </Card>

          <RecoveryPanel />

          <If when={onboardingPending()}>
            <View testID="onboarding-pending" class="py-8 items-center justify-center">
              <Spinner label={t("common.loading")} />
            </View>
          </If>

          <If when={showOnboarding()}>
            <OnboardingScreen />
          </If>

          <If when={!onboardingPending() && !showOnboarding() && activeSection() === "keys"}>
            <KeysScreen onNotify={pushToast} />
          </If>

          <If when={!onboardingPending() && !showOnboarding() && activeSection() === "settings"}>
            <SettingsScreen languageLoadFailed={language.error() !== undefined} />
          </If>

          <If when={!onboardingPending() && !showOnboarding() && activeSection() === "conversation"}>
            <ConversationScreen />
          </If>

          <If when={!onboardingPending() && !showOnboarding() && activeSection() === "activity"}>
            <ActivityScreen />
          </If>

          {process.env.NODE_ENV !== "production" ? (
            <If when={!onboardingPending() && !showOnboarding() && activeSection() === "gallery"}>
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
