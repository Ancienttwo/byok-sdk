import { effect, mount, View } from "nsh";
import { startShell } from "../../store.ts";
import { Button } from "../../ui/index.ts";
import { SettingsScreen } from "./SettingsScreen.tsx";

/** Minimal test harness that exercises `SettingsScreen` across real `startShell()` hostReady transitions. */
function SettingsRestartFixture() {
  effect(() => {
    void startShell();
  });

  return (
    <View class="p-4 gap-4">
      <Button testID="fixture-restart" variant="outline" size="sm" onPress={() => void startShell()}>
        Restart
      </Button>
      <SettingsScreen />
    </View>
  );
}

mount(() => <SettingsRestartFixture />);
