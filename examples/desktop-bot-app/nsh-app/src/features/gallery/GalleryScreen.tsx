import { t } from "../../i18n.ts";
import { signal, Text, View } from "nsh";
import { addTranslations } from "nsh/i18n";
import translations from "./translations.json";
import brand from "../../../../brand.config.ts";
import { BridgeCallError, submitSecret } from "../../bridge.ts";
import { openAllowedExternalUrl } from "../../links.ts";
import { setPreviewHostState } from "../../store.ts";
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
  Tooltip,
  type ToastNotice,
} from "../../ui/index.ts";

const BLOCKED_EXTERNAL_URL = "https://evil.example/phish";

const RUNTIME_ITEMS = [
  { value: "pi", title: "Pi Runtime" },
  { value: "claude", title: "Claude Code" },
  { value: "codex", title: "Codex" },
];

export function loadGalleryTranslations(): void {
  addTranslations(translations);
}

export interface GalleryScreenProps {
  onNotify: (tone: ToastNotice["tone"], title: ToastNotice["title"], description?: ToastNotice["description"]) => void;
}

/**
 * Foundations Gallery: every src/ui component and Host-state token on one screen. Development builds
 * only; App.tsx mounts it behind the compile-time `process.env.NODE_ENV` check, so a release bundle
 * leaves this module out.
 */
export function GalleryScreen(props: GalleryScreenProps) {
  // Derived inside the component so the module has no top-level reads that could keep it in a bundle.
  const allowedOrigin = brand.externalOrigins[0] ?? "https://example.org";
  const allowedUrl = `${allowedOrigin}/docs`;
  const allowlist = brand.externalOrigins.length > 0 ? brand.externalOrigins : [allowedOrigin];

  const standardInput = signal("");
  const notesInput = signal("");
  const secretValue = signal("");
  const secretStatus = signal<() => string>(() => t("gallery.secretPending"));
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
  const linkStatus = signal<() => string>(() => t("gallery.linkReady"));

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
      secretStatus.set(() => t("gallery.secretSubmitted"));
      props.onNotify("success", () => t("gallery.credentialSubmitted"), () => t("gallery.credentialDescription"));
    } catch (error) {
      const code = error instanceof BridgeCallError ? error.code : "method_failed";
      secretStatus.set(() => t("gallery.secretFailed", { code }));
      props.onNotify("warning", () => t("gallery.bridgeUnavailable"), () => t("gallery.bridgeCode", { code }));
    } finally {
      secretSubmitting.set(false);
    }
  };

  const handleOpenAllowedLink = async (href: string) => {
    const opened = await openAllowedExternalUrl(href, allowlist);
    linkStatus.set(() => t(opened ? "gallery.linkOpened" : "gallery.linkBlocked", { href }));
  };

  const handleOpenBlockedLink = async (href: string) => {
    const opened = await openAllowedExternalUrl(href);
    linkStatus.set(() => t(opened ? "gallery.linkOpened" : "gallery.linkBlocked", { href }));
  };

  return (
    <View testID="gallery-section" class="gap-6">
      {/* Actions & Semantic Status */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gallery.actions")}</CardTitle>
          <CardDescription>
            {t("gallery.actionsDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <View class="flex-row flex-wrap items-center gap-2">
            <Button variant="primary" size="md" onPress={() => props.onNotify("info", () => t("gallery.primaryAction"))}>
              {t("gallery.primary")}
            </Button>
            <Button variant="secondary" size="md">{t("gallery.secondary")}</Button>
            <Button variant="outline" size="md">{t("gallery.outline")}</Button>
            <Button variant="ghost" size="md">{t("gallery.ghost")}</Button>
            <Button variant="danger" size="md">{t("gallery.danger")}</Button>
            <Button variant="primary" size="sm" loading>
              {t("gallery.loading")}
            </Button>
            <Button variant="outline" size="sm" disabled>
              {t("gallery.disabled")}
            </Button>
            <IconButton
              icon="refresh"
              variant="outline"
              size="md"
              accessibilityLabel={t("gallery.refresh")}
              onPress={() => props.onNotify("info", () => t("gallery.refreshed"))}
            />
          </View>
          <Separator />
          <View class="flex-row flex-wrap items-center gap-2">
            <Badge variant="neutral" label={t("gallery.neutral")} />
            <Badge variant="primary" label={t("gallery.primary")} />
            <Badge variant="success" symbol="✓" label={t("gallery.success")} />
            <Badge variant="warning" symbol="!" label={t("gallery.warning")} />
            <Badge variant="danger" symbol="×" label={t("gallery.danger")} />
          </View>
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class="text-xs font-medium text-muted-foreground">{t("gallery.hostPreview")}</Text>
            <Button
              testID="host-preview-starting"
              size="sm"
              variant="ghost"
              onPress={() => setPreviewHostState({ state: "starting", pid: 4100 })}
            >
              {t("host.starting")}
            </Button>
            <Button
              testID="host-preview-running"
              size="sm"
              variant="ghost"
              onPress={() => setPreviewHostState({ state: "running", pid: 4100, activeWork: 2 })}
            >
              {t("host.running")}
            </Button>
            <Button
              testID="host-preview-restarting"
              size="sm"
              variant="ghost"
              onPress={() => setPreviewHostState({ state: "restarting", inMs: 2500, reason: "crash" })}
            >
              {t("host.restarting")}
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
              {t("host.stopped")}
            </Button>
            <Button
              testID="host-preview-failed"
              size="sm"
              variant="ghost"
              onPress={() => setPreviewHostState({ state: "failed", reason: "exit 1" })}
            >
              {t("host.failed")}
            </Button>
          </View>
        </CardContent>
      </Card>

      {/* Inputs & Option A Secret Boundary */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gallery.inputs")}</CardTitle>
          <CardDescription>
            {t("gallery.inputsDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            label={t("gallery.workspaceLabel")}
            description={t("gallery.workspaceFont")}
          >
            <Input
              testID="text-input"
              value={standardInput()}
              placeholder={t("gallery.workspacePlaceholder")}
              accessibilityLabel={t("gallery.workspaceName")}
              onChange={(e) => standardInput.set(e.value)}
            />
          </Field>
          <Field label={t("gallery.validation")} error={t("gallery.validationError")}>
            <Input value="bad/path" invalid accessibilityLabel={t("gallery.invalidExample")} />
          </Field>
          <Field label={t("gallery.notesLabel")}>
            <Textarea
              testID="text-area"
              value={notesInput()}
              placeholder={t("gallery.notesPlaceholder")}
              accessibilityLabel={t("gallery.notesName")}
              onChange={(e) => notesInput.set(e.value)}
            />
          </Field>
          <Separator />
          <Field
            label={t("gallery.secretLabel")}
            required
            description={t("gallery.secretDescription")}
          >
            <View class="flex-row items-center gap-2">
              <View class="flex-1">
                <Input
                  testID="secret-input"
                  variant="masked"
                  value={secretValue()}
                  placeholder="sk-..."
                  accessibilityLabel={t("gallery.secretName")}
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
                {t("gallery.submitKey")}
              </Button>
            </View>
          </Field>
          <Text testID="secret-status" class="text-xs text-muted-foreground">
            {t("gallery.secretStatus", { status: secretStatus()() })}
          </Text>
        </CardContent>
      </Card>

      {/* Selection & Disclosure */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gallery.controls")}</CardTitle>
          <CardDescription>
            {t("gallery.controlsDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <View class="flex-row flex-wrap items-center gap-6">
            <Switch
              testID="toggle-autosave"
              checked={autosaveEnabled()}
              label={autosaveEnabled() ? t("gallery.autosaveOn") : t("gallery.autosaveOff")}
              onChange={(checked) => autosaveEnabled.set(checked)}
            />
            <Checkbox
              testID="check-terms"
              checked={termsAccepted()}
              label={termsAccepted() ? t("gallery.auditConfirmed") : t("gallery.auditConfirm")}
              onChange={(checked) => termsAccepted.set(checked)}
            />
            <Checkbox
              testID="check-partial"
              indeterminate={partialSelection()}
              checked={!partialSelection()}
              label={t("gallery.partialSelection")}
              onChange={() => partialSelection.update((value) => !value)}
            />
          </View>
          <View class="flex-row flex-wrap items-center gap-4">
            <View class="w-56">
              <Select
                testID="runtime-select"
                items={RUNTIME_ITEMS}
                value={selectedRuntime()}
                accessibilityLabel={t("gallery.runtime")}
                onChange={(value) => selectedRuntime.set(value)}
              />
            </View>
            <Tabs accessibilityLabel={t("gallery.sections")}>
              <Tab
                testID="tab-overview"
                selected={activeTab() === "overview"}
                onPress={() => activeTab.set("overview")}
              >
                {t("gallery.tab.overview")}
              </Tab>
              <Tab
                testID="tab-tokens"
                selected={activeTab() === "tokens"}
                onPress={() => activeTab.set("tokens")}
              >
                {t("gallery.tab.tokens")}
              </Tab>
              <Tab
                testID="tab-states"
                selected={activeTab() === "states"}
                onPress={() => activeTab.set("states")}
              >
                {t("gallery.tab.states")}
              </Tab>
            </Tabs>
          </View>
          <Text testID="tab-selection-label" class="text-xs text-muted-foreground">
            {t("gallery.selection", { tab: t(`gallery.tab.${activeTab()}`), runtime: selectedRuntime() ?? t("gallery.none") })}
          </Text>
          <Disclosure
            testID="disclosure-trigger"
            open={disclosureOpen()}
            title={t("gallery.invariants")}
            summary={disclosureOpen() ? t("gallery.expanded") : t("gallery.collapsed")}
            onToggle={(nextOpen) => disclosureOpen.set(nextOpen)}
          >
            <Text class="text-xs text-foreground">
              {t("gallery.invariantsDetail")}
            </Text>
          </Disclosure>
        </CardContent>
      </Card>

      {/* Surfaces, Lists & Feedback */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gallery.surfaces")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ListItem
            testID="list-item-demo"
            title="Writer Bot"
            description={t("gallery.readyOnPi")}
            leading={<Avatar name="Writer Bot" size="sm" />}
            trailing={<Badge variant="hostRunning" symbol="●" label={t("conversation.state.idle")} />}
            selected
            onPress={() => props.onNotify("info", () => t("gallery.selectedWriter"))}
          />
          <View class="flex-row flex-wrap items-center gap-4">
            <Spinner label={t("gallery.syncing")} />
            <View class="w-40 gap-1.5">
              <Skeleton class="w-full" />
              <Skeleton class="w-28" />
            </View>
          </View>
          <Empty
            title={t("gallery.empty")}
            description={t("gallery.emptyDescription")}
          />
        </CardContent>
      </Card>

      {/* Overlays & External Link UI Allowlist */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gallery.overlays")}</CardTitle>
          <CardDescription>
            {t("gallery.overlaysDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <View class="flex-row flex-wrap items-center gap-2">
            <Button testID="open-dialog-btn" variant="outline" onPress={() => dialogOpen.set(true)}>
              {t("gallery.openDialog")}
            </Button>
            <Button testID="open-sheet-btn" variant="outline" onPress={() => sheetOpen.set(true)}>
              {t("gallery.openSheet")}
            </Button>
            <Button
              testID="toast-trigger-btn"
              variant="secondary"
              onPress={() => props.onNotify("info", () => t("gallery.notice"), () => t("gallery.noticeDescription"))}
            >
              {t("gallery.showToast")}
            </Button>
            <Tooltip text={t("gallery.shortcuts")}>
              <Popover
                open={popoverOpen()}
                onOpenChange={(next) => popoverOpen.set(next)}
                trigger={
                  <Button testID="open-popover-btn" variant="ghost">
                    {t("gallery.popover")}
                  </Button>
                }
              >
                <View class="gap-1">
                  <Text class="text-xs font-medium text-popover-foreground">{t("gallery.inspector")}</Text>
                  <Text class="text-xs text-muted-foreground">{t("gallery.inspectorDescription")}</Text>
                </View>
              </Popover>
            </Tooltip>
            <Menu
              open={menuOpen()}
              onOpenChange={(next) => menuOpen.set(next)}
              trigger={
                <Button testID="open-menu-btn" variant="outline">
                  {t("gallery.commandMenu")}
                </Button>
              }
            >
              <MenuItem
                label={t("gallery.inspectLogs")}
                icon="info"
                checked={menuSelection() === "Logs"}
                onSelect={() => menuSelection.set("Logs")}
              />
              <MenuSeparator />
              <MenuItem
                label={t("gallery.reset")}
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
              label={t("gallery.allowedLink")}
              href={allowedUrl}
              onOpen={handleOpenAllowedLink}
            />
            <Button
              testID="link-blocked"
              variant="outline"
              size="sm"
              onPress={() => handleOpenBlockedLink(BLOCKED_EXTERNAL_URL)}
            >
              {t("gallery.blockedLink")}
            </Button>
            <Text testID="link-status" class="text-xs text-muted-foreground">
              {t("gallery.linkStatus", { status: linkStatus()() })}
            </Text>
          </View>
        </CardContent>
        <CardFooter>
          <Text class="text-xs text-muted-foreground">
            {t("gallery.capabilities", { item: t(`gallery.menu.${menuSelection()}`) })}
          </Text>
        </CardFooter>
      </Card>

      <Dialog
        testID="demo-dialog"
        open={dialogOpen()}
        title={t("gallery.dialog")}
        description={t("gallery.dialogDescription")}
        onOpenChange={(open) => dialogOpen.set(open)}
        footer={
          <Button testID="dialog-close-confirm" variant="primary" size="sm" onPress={() => dialogOpen.set(false)}>
            {t("gallery.done")}
          </Button>
        }
      >
        <Text class="text-sm text-foreground">
          {t("gallery.dialogDetail")}
        </Text>
      </Dialog>

      <Sheet
        testID="demo-sheet"
        open={sheetOpen()}
        title={t("gallery.sheet")}
        onOpenChange={(open) => sheetOpen.set(open)}
        footer={
          <Button variant="secondary" size="sm" onPress={() => sheetOpen.set(false)}>
            {t("common.close")}
          </Button>
        }
      >
        <Text class="text-sm text-foreground">
          {t("gallery.sheetDescription")}
        </Text>
      </Sheet>
    </View>
  );
}
