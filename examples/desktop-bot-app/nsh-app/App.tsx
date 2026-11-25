import { cleanup, effect, mount, platform, Scroll, signal, Text, View } from "nsh";
import { currentWindow, isAvailable } from "nsh/desktop";
import brand from "../brand.config.ts";
import { BridgeCallError, submitSecret } from "./src/bridge.ts";
import { installDesktopShell, syncDesktopChrome } from "./src/desktop.ts";
import { KeysScreen } from "./src/features/keys/KeysScreen.tsx";
import { LoginItemControl } from "./src/features/shell/LoginItemControl.tsx";
import { DiagnosticsExportButton, RecoveryPanel } from "./src/features/shell/RecoveryPanel.tsx";
import { ShellSidebar } from "./src/features/shell/ShellSidebar.tsx";
import { openAllowedExternalUrl } from "./src/links.ts";
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
  setPreviewHostState,
  showMainWindow,
  startShell,
  stateHintCount,
  type WorkspaceSection,
} from "./src/store.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  Disclosure,
  Empty,
  Field,
  HostStateBadge,
  IconButton,
  Input,
  LinkText,
  ListItem,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  Select,
  Separator,
  Sheet,
  Skeleton,
  Spinner,
  Switch,
  Tab,
  Tabs,
  Textarea,
  ToastRegion,
  Tooltip,
  type ToastNotice,
} from "./src/ui/index.ts";

const GALLERY_ALLOWLISTED_ORIGIN =
  brand.externalOrigins[0] ?? "https://example.org";
const GALLERY_ALLOWLISTED_URL = `${GALLERY_ALLOWLISTED_ORIGIN}/docs`;
const GALLERY_ALLOWLIST =
  brand.externalOrigins.length > 0 ? brand.externalOrigins : [GALLERY_ALLOWLISTED_ORIGIN];
const BLOCKED_EXTERNAL_URL = "https://evil.example/phish";

const RUNTIME_ITEMS = [
  { value: "pi", title: "Pi Runtime" },
  { value: "claude", title: "Claude Code" },
  { value: "codex", title: "Codex" },
];

const SECTION_TITLES: Record<WorkspaceSection, string> = {
  conversation: "Conversation",
  activity: "Activity",
  settings: "Settings",
  keys: "Keys",
  gallery: "Foundations Gallery",
};

export function App() {
  const win = isAvailable ? currentWindow() : null;

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

  const standardInput = signal("");
  const notesInput = signal("");
  const secretValue = signal("");
  const secretStatus = signal("Not submitted");
  const secretSubmitting = signal(false);

  const autosaveEnabled = signal(true);
  const termsAccepted = signal(false);
  const partialSelection = signal(true);
  const selectedRuntime = signal<string | null>("pi");
  const activeTab = signal<"overview" | "tokens" | "states">("overview");
  const disclosureOpen = signal(false);

  const dialogOpen = signal(false);
  const sheetOpen = signal(false);
  const menuOpen = signal(false);
  const popoverOpen = signal(false);
  const menuSelection = signal("None");
  const linkStatus = signal("Ready");
  const notices = signal<ToastNotice[]>([]);

  const pushToast = (tone: ToastNotice["tone"], title: string, description?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    notices.update((list) => [...list.slice(-3), { id, tone, title, description }]);
  };

  const dismissToast = (id: string) => {
    notices.update((list) => list.filter((item) => item.id !== id));
  };

  const handleSubmitSecret = async () => {
    if (!secretValue() || secretSubmitting()) {
      return;
    }
    secretSubmitting.set(true);
    try {
      await submitSecret({
        clearSecret: () => secretValue.set(""),
        buildPayload: () => ({
          op: "replace_secret",
          profileRef: "foundations-demo",
          secret: secretValue(),
        }),
      });
      secretStatus.set("Submitted (signal cleared before bridge call)");
      pushToast("success", "Credential submitted", "Cleared reactive input signal before bridge handoff.");
    } catch (error) {
      const code = error instanceof BridgeCallError ? error.code : "method_failed";
      secretStatus.set(`Bridge error (${code})`);
      pushToast("warning", "Bridge unavailable in preview", `Code: ${code}`);
    } finally {
      secretSubmitting.set(false);
    }
  };

  const handleOpenAllowedLink = async (href: string) => {
    const opened = await openAllowedExternalUrl(href, GALLERY_ALLOWLIST);
    linkStatus.set(opened ? `Opened ${href}` : `Blocked ${href}`);
  };

  const handleOpenBlockedLink = async (href: string) => {
    const opened = await openAllowedExternalUrl(href);
    linkStatus.set(opened ? `Opened ${href}` : `Blocked ${href}`);
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
            <View testID="settings-section" class="gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Startup &amp; System</CardTitle>
                  <CardDescription>
                    OS-authoritative login-item preference synced directly with desktop services.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LoginItemControl />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Diagnostics</CardTitle>
                  <CardDescription>
                    Export a redacted snapshot of supervised Host logs and S1 store state.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DiagnosticsExportButton testID="settings-diagnostics-btn" disabled={isQuitting()} />
                </CardContent>
              </Card>
            </View>
          </If>

          <If when={activeSection() === "conversation"}>
            <View testID="conversation-section">
              <Card>
                <CardHeader>
                  <CardTitle>Conversation</CardTitle>
                  <CardDescription>
                    Native conversation workspace arrives in Slice 4 of #2461.
                  </CardDescription>
                </CardHeader>
              </Card>
            </View>
          </If>

          <If when={activeSection() === "activity"}>
            <View testID="activity-section">
              <Card>
                <CardHeader>
                  <CardTitle>Activity</CardTitle>
                  <CardDescription>
                    Native activity feed and run traces arrive in Slice 5 of #2461.
                  </CardDescription>
                </CardHeader>
              </Card>
            </View>
          </If>

          <If when={activeSection() === "gallery"}>
            <View class="gap-6">

        {/* Actions & Semantic Status */}
        <Card>
          <CardHeader>
            <CardTitle>Actions &amp; Status Tokens</CardTitle>
            <CardDescription>
              Desktop-scaled buttons, icon actions, semantic pills, and Host lifecycle previews.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <View class="flex-row flex-wrap items-center gap-2">
              <Button variant="primary" size="md" onPress={() => pushToast("info", "Primary action")}>
                Primary
              </Button>
              <Button variant="secondary" size="md">Secondary</Button>
              <Button variant="outline" size="md">Outline</Button>
              <Button variant="ghost" size="md">Ghost</Button>
              <Button variant="danger" size="md">Danger</Button>
              <Button variant="primary" size="sm" loading>
                Loading
              </Button>
              <Button variant="outline" size="sm" disabled>
                Disabled
              </Button>
              <IconButton
                icon="refresh"
                variant="outline"
                size="md"
                accessibilityLabel="Refresh preview"
                onPress={() => pushToast("info", "Preview refreshed")}
              />
            </View>
            <Separator />
            <View class="flex-row flex-wrap items-center gap-2">
              <Badge variant="neutral" label="Neutral" />
              <Badge variant="primary" label="Primary" />
              <Badge variant="success" symbol="✓" label="Success" />
              <Badge variant="warning" symbol="!" label="Warning" />
              <Badge variant="danger" symbol="×" label="Danger" />
            </View>
            <View class="flex-row flex-wrap items-center gap-2">
              <Text class="text-xs font-medium text-muted-foreground">Host State Preview:</Text>
              <Button
                testID="host-preview-starting"
                size="sm"
                variant="ghost"
                onPress={() => setPreviewHostState({ state: "starting", pid: 4100 })}
              >
                Starting
              </Button>
              <Button
                testID="host-preview-running"
                size="sm"
                variant="ghost"
                onPress={() => setPreviewHostState({ state: "running", pid: 4100, activeWork: 2 })}
              >
                Running
              </Button>
              <Button
                testID="host-preview-restarting"
                size="sm"
                variant="ghost"
                onPress={() => setPreviewHostState({ state: "restarting", inMs: 2500, reason: "crash" })}
              >
                Restarting
              </Button>
              <Button
                testID="host-preview-stopped"
                size="sm"
                variant="ghost"
                onPress={() =>
                  setPreviewHostState({
                    state: "stopped",
                    pid: 4100,
                    reason: "clean",
                    storeRefused: false,
                  })
                }
              >
                Stopped
              </Button>
              <Button
                testID="host-preview-failed"
                size="sm"
                variant="ghost"
                onPress={() => setPreviewHostState({ state: "failed", reason: "exit 1" })}
              >
                Failed
              </Button>
            </View>
          </CardContent>
        </Card>

        {/* Inputs & Option A Secret Boundary */}
        <Card>
          <CardHeader>
            <CardTitle>Inputs &amp; Credential Boundary (Option A)</CardTitle>
            <CardDescription>
              Centralized Windows CJK font token on standard inputs and pre-bridge signal clearing on masked secrets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Field
              label="Workspace Label (CJK & Latin)"
              description="Uses font-cjk on Windows automatically inside src/ui/Input.tsx."
            >
              <Input
                testID="text-input"
                value={standardInput()}
                placeholder="Type label or 中文..."
                accessibilityLabel="Workspace label"
                onChange={(e) => standardInput.set(e.value)}
              />
            </Field>
            <Field label="Validation Example" error="Workspace name cannot contain path separators.">
              <Input value="bad/path" invalid accessibilityLabel="Invalid example" />
            </Field>
            <Field label="Prompt Notes">
              <Textarea
                testID="text-area"
                value={notesInput()}
                placeholder="Multiline prompt or 中文笔记..."
                accessibilityLabel="Prompt notes"
                onChange={(e) => notesInput.set(e.value)}
              />
            </Field>
            <Separator />
            <Field
              label="Provider API Key (Masked)"
              required
              description="Clears QuickJS signal synchronously before invoking ByokShell.call('keys.submit')."
            >
              <View class="flex-row items-center gap-2">
                <View class="flex-1">
                  <Input
                    testID="secret-input"
                    variant="masked"
                    value={secretValue()}
                    placeholder="sk-..."
                    accessibilityLabel="Provider API key"
                    onChange={(e) => secretValue.set(e.value)}
                    onSubmit={handleSubmitSecret}
                  />
                </View>
                <Button
                  testID="secret-submit"
                  variant="primary"
                  loading={secretSubmitting()}
                  disabled={!secretValue()}
                  onPress={handleSubmitSecret}
                >
                  Submit Key
                </Button>
              </View>
            </Field>
            <Text testID="secret-status" class="text-xs text-muted-foreground">
              {`Secret status: ${secretStatus()}`}
            </Text>
          </CardContent>
        </Card>

        {/* Selection & Disclosure */}
        <Card>
          <CardHeader>
            <CardTitle>Selection &amp; Disclosure Controls</CardTitle>
            <CardDescription>
              Accessible Switch, Checkbox, Select, Tabs, and Collapsible Disclosure components.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <View class="flex-row flex-wrap items-center gap-6">
              <Switch
                testID="toggle-autosave"
                checked={autosaveEnabled()}
                label={autosaveEnabled() ? "Auto-save On" : "Auto-save Off"}
                onChange={(checked) => autosaveEnabled.set(checked)}
              />
              <Checkbox
                testID="check-terms"
                checked={termsAccepted()}
                label={termsAccepted() ? "Audit Confirmed" : "Confirm Audit"}
                onChange={(checked) => termsAccepted.set(checked)}
              />
              <Checkbox
                testID="check-partial"
                indeterminate={partialSelection()}
                checked={!partialSelection()}
                label="Partial Selection"
                onChange={() => partialSelection.update((value) => !value)}
              />
            </View>
            <View class="flex-row flex-wrap items-center gap-4">
              <View class="w-56">
                <Select
                  testID="runtime-select"
                  items={RUNTIME_ITEMS}
                  value={selectedRuntime()}
                  accessibilityLabel="Default runtime"
                  onChange={(value) => selectedRuntime.set(value)}
                />
              </View>
              <Tabs accessibilityLabel="Gallery sections">
                <Tab
                  testID="tab-overview"
                  selected={activeTab() === "overview"}
                  onPress={() => activeTab.set("overview")}
                >
                  Overview
                </Tab>
                <Tab
                  testID="tab-tokens"
                  selected={activeTab() === "tokens"}
                  onPress={() => activeTab.set("tokens")}
                >
                  Tokens
                </Tab>
                <Tab
                  testID="tab-states"
                  selected={activeTab() === "states"}
                  onPress={() => activeTab.set("states")}
                >
                  States
                </Tab>
              </Tabs>
            </View>
            <Text testID="tab-selection-label" class="text-xs text-muted-foreground">
              {`Selected tab: ${activeTab()} • Runtime: ${selectedRuntime() ?? "none"}`}
            </Text>
            <Disclosure
              testID="disclosure-trigger"
              open={disclosureOpen()}
              title="Architecture Invariants"
              summary={disclosureOpen() ? "Expanded" : "Collapsed"}
              onToggle={(nextOpen) => disclosureOpen.set(nextOpen)}
            >
              <Text class="text-xs text-foreground">
                One bridge type authority in src/bridge/protocol.ts; zero Node or SDK runtime bundled into QuickJS.
              </Text>
            </Disclosure>
          </CardContent>
        </Card>

        {/* Surfaces, Lists & Feedback */}
        <Card>
          <CardHeader>
            <CardTitle>Surfaces, Lists &amp; Feedback</CardTitle>
          </CardHeader>
          <CardContent>
            <ListItem
              testID="list-item-demo"
              title="Writer Bot"
              description="Ready on Pi Runtime"
              leading={<Avatar name="Writer Bot" size="sm" />}
              trailing={<Badge variant="hostRunning" symbol="●" label="Idle" />}
              selected
              onPress={() => pushToast("info", "Selected Writer Bot")}
            />
            <View class="flex-row flex-wrap items-center gap-4">
              <Spinner label="Syncing runtime status" />
              <View class="w-40 gap-1.5">
                <Skeleton class="w-full" />
                <Skeleton class="w-28" />
              </View>
            </View>
            <Empty
              title="No active Bot tasks"
              description="Tasks started from Conversations will stream live telemetry here."
            />
          </CardContent>
        </Card>

        {/* Overlays & External Link UI Allowlist */}
        <Card>
          <CardHeader>
            <CardTitle>Overlays &amp; External Link UI Allowlist</CardTitle>
            <CardDescription>
              Escape-dismissible overlays and UI-layer https + brand.externalOrigins allowlist (enforced under ADR-052 D2 + #2457 D-O3).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <View class="flex-row flex-wrap items-center gap-2">
              <Button testID="open-dialog-btn" variant="outline" onPress={() => dialogOpen.set(true)}>
                Open Dialog
              </Button>
              <Button testID="open-sheet-btn" variant="outline" onPress={() => sheetOpen.set(true)}>
                Open Sheet
              </Button>
              <Button
                testID="toast-trigger-btn"
                variant="secondary"
                onPress={() => pushToast("info", "Notice banner", "Rendered in bottom-right ToastRegion.")}
              >
                Show Toast
              </Button>
              <Tooltip text="Keyboard shortcuts & commands">
                <Popover
                  open={popoverOpen()}
                  onOpenChange={(next) => popoverOpen.set(next)}
                  trigger={
                    <Button testID="open-popover-btn" variant="ghost">
                      Open Popover
                    </Button>
                  }
                >
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-popover-foreground">Quick Inspector</Text>
                    <Text class="text-xs text-muted-foreground">Dismisses on Escape or outside click.</Text>
                  </View>
                </Popover>
              </Tooltip>
              <Menu
                open={menuOpen()}
                onOpenChange={(next) => menuOpen.set(next)}
                trigger={
                  <Button testID="open-menu-btn" variant="outline">
                    Command Menu
                  </Button>
                }
              >
                <MenuItem
                  label="Inspect Logs"
                  icon="info"
                  checked={menuSelection() === "Logs"}
                  onSelect={() => menuSelection.set("Logs")}
                />
                <MenuSeparator />
                <MenuItem
                  label="Reset Gallery"
                  icon="refresh"
                  destructive
                  onSelect={() => menuSelection.set("Reset")}
                />
              </Menu>
            </View>
            <Separator />
            <View class="flex-row flex-wrap items-center gap-4">
              <LinkText
                testID="link-allowed"
                label="Allowlisted Docs Link"
                href={GALLERY_ALLOWLISTED_URL}
                onOpen={handleOpenAllowedLink}
              />
              <Button
                testID="link-blocked"
                variant="outline"
                size="sm"
                onPress={() => handleOpenBlockedLink(BLOCKED_EXTERNAL_URL)}
              >
                Test Blocked URL
              </Button>
              <Text testID="link-status" class="text-xs text-muted-foreground">
                {`Link status: ${linkStatus()}`}
              </Text>
            </View>
          </CardContent>
          <CardFooter>
            <Text class="text-xs text-muted-foreground">
              {`Capabilities: application + https openUrl • Menu: ${menuSelection()}`}
            </Text>
          </CardFooter>
        </Card>
            </View>
          </If>
        </Scroll>
      </View>

      <Dialog
        testID="demo-dialog"
        open={dialogOpen()}
        title="Foundations Dialog"
        description="Press Escape or Close to dismiss."
        onOpenChange={(open) => dialogOpen.set(open)}
        footer={
          <Button testID="dialog-close-confirm" variant="primary" size="sm" onPress={() => dialogOpen.set(false)}>
            Done
          </Button>
        }
      >
        <Text class="text-sm text-foreground">
          Dialog focus, Escape key dismissal, and backdrop handling run through nsh/base Dialog.
        </Text>
      </Dialog>

      <Sheet
        testID="demo-sheet"
        open={sheetOpen()}
        title="Inspector Drawer"
        onOpenChange={(open) => sheetOpen.set(open)}
        footer={
          <Button variant="secondary" size="sm" onPress={() => sheetOpen.set(false)}>
            Close
          </Button>
        }
      >
        <Text class="text-sm text-foreground">
          Edge-anchored inspector panel using semantic popover surface tokens.
        </Text>
      </Sheet>

      <ToastRegion
        notices={notices()}
        onDismiss={dismissToast}
        onClearAll={() => notices.set([])}
      />
    </View>
  );
}

mount(() => <App />);
