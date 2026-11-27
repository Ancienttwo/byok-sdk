import { colorScheme, mount, signal, Text, token, View } from "nsh";
import { appearance, setAppearance } from "../store.ts";
import { Badge, Button, Card, HostStateBadge, ListItem, Surface, Switch, Tab, Tabs } from "./index.ts";

const switchChecked = signal(false);
const activeTab = signal<"a" | "b">("a");

function tokenSnapshot(): string {
  return JSON.stringify({
    appearance: appearance(),
    colorScheme: colorScheme(),
    radius: token("radius"),
    background: token("background"),
    foreground: token("foreground"),
    card: token("card"),
    popover: token("popover"),
    primary: token("primary"),
    primaryForeground: token("primary-foreground"),
    secondary: token("secondary"),
    muted: token("muted"),
    mutedForeground: token("muted-foreground"),
    tertiaryForeground: token("tertiary-foreground"),
    success: token("success"),
    warning: token("warning"),
    destructive: token("destructive"),
    border: token("border"),
    segmentedThumb: token("segmented-thumb"),
    sidebar: token("sidebar"),
    hostStarting: token("host-starting"),
    hostStartingFg: token("host-starting-foreground"),
    hostRunning: token("host-running"),
    hostRunningFg: token("host-running-foreground"),
    hostRestarting: token("host-restarting"),
    hostRestartingFg: token("host-restarting-foreground"),
    hostStopped: token("host-stopped"),
    hostStoppedFg: token("host-stopped-foreground"),
    hostFailed: token("host-failed"),
    hostFailedFg: token("host-failed-foreground"),
  });
}

mount(() => (
  <View testID="theme-root" class="flex-1 bg-background p-4 gap-3">
    <Text testID="token-snapshot">{tokenSnapshot()}</Text>

    <Card testID="grouped-card">
      <ListItem testID="grouped-row" title="Grouped Row" description="44 pt iOS row" />
    </Card>
    <Surface testID="muted-surface" tone="muted" class="p-2">
      <Text class="text-xs text-foreground">Muted Surface</Text>
    </Surface>

    <View class="flex-row gap-2">
      <Button testID="btn-primary" variant="primary">Primary</Button>
      <Button testID="btn-secondary" variant="secondary">Secondary</Button>
      <Button testID="btn-outline" variant="outline">Outline</Button>
      <Button testID="btn-ghost" variant="ghost">Ghost</Button>
      <Button testID="btn-danger" variant="danger">Danger</Button>
    </View>

    <Switch
      testID="ios-switch"
      checked={switchChecked()}
      label="Green Switch"
      onChange={(next) => switchChecked.set(next)}
    />

    <Tabs testID="ios-tabs" accessibilityLabel="Segmented demo">
      <Tab testID="seg-a" selected={activeTab() === "a"} onPress={() => activeTab.set("a")}>
        First
      </Tab>
      <Tab testID="seg-b" selected={activeTab() === "b"} onPress={() => activeTab.set("b")}>
        Second
      </Tab>
    </Tabs>

    <View class="flex-row gap-2">
      <Button testID="mode-light" size="sm" variant="ghost" onPress={() => setAppearance("light")}>
        Mode Light
      </Button>
      <Button testID="mode-dark" size="sm" variant="ghost" onPress={() => setAppearance("dark")}>
        Mode Dark
      </Button>
      <Button testID="mode-system" size="sm" variant="ghost" onPress={() => setAppearance("system")}>
        Mode System
      </Button>
    </View>

    <View class="flex-row flex-wrap gap-2">
      <HostStateBadge testID="host-starting" state={{ state: "starting", pid: 1 }} />
      <HostStateBadge testID="host-running" state={{ state: "running", pid: 1, activeWork: 2 }} />
      <HostStateBadge testID="host-restarting" state={{ state: "restarting", inMs: 1200, reason: "retry" }} />
      <HostStateBadge
        testID="host-stopped"
        state={{ state: "stopped", pid: 1, reason: "clean", storeRefused: false }}
      />
      <HostStateBadge testID="host-failed" state={{ state: "failed", reason: "exit 1" }} />
      <HostStateBadge testID="host-offline" state={null} />
    </View>

    <View class="flex-row flex-wrap gap-2">
      <Badge testID="badge-neutral" variant="neutral" label="Neutral" />
      <Badge testID="badge-primary" variant="primary" label="Primary" />
      <Badge testID="badge-success" variant="success" symbol="✓" label="Success" />
      <Badge testID="badge-warning" variant="warning" symbol="!" label="Warning" />
      <Badge testID="badge-danger" variant="danger" symbol="×" label="Danger" />
    </View>
  </View>
));
