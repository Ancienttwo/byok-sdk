import { List, Text, View } from "nsh";
import { toBridgeCallError } from "../../bridge.ts";
import { activityCards, hostReady, reloadActivityCards } from "../../store.ts";
import { Button, Empty, Spinner } from "../../ui/index.ts";
import { ActivityCardView } from "./ActivityCardView.tsx";

/**
 * The tasks the Host follows, newest first, from the store's one `activity.cards` load. A refused load shows its error
 * instead of the last cards.
 */
export function ActivityScreen() {
  const failure = () => {
    const error = activityCards.error();
    return error === undefined ? null : toBridgeCallError(error).message;
  };
  return (
    <View testID="activity-section" class="gap-4">
      <If
        when={failure()}
        else={
          <If
            when={activityCards()}
            else={
              <View class="flex-row items-center gap-2" accessibilityState={{ busy: true }}>
                <Spinner />
                <Text class="text-sm text-muted-foreground">
                  {hostReady() ? "Loading activity…" : "Activity loads once the Host runs."}
                </Text>
              </View>
            }
          >
            {(cards) => (
              <List
                testID="activity-list"
                role="list"
                accessibilityLabel="Activity"
                viewport="parent"
                contentClass="gap-3"
                each={cards()}
                keyExtractor={(card) => card.taskId}
                estimatedItemSize={120}
                empty={<Empty title="No tasks since the Host started." />}
              >
                {(card) => (
                  // A List cell outlives its card: scrolling and reloads reuse it for another task. Mounting per taskId
                  // gives each card its own renderer; what must survive a remount (expanded, decisions) is in the store.
                  <Each of={[card()]} key={(current) => current.taskId}>
                    {(current) => <ActivityCardView card={current} />}
                  </Each>
                )}
              </List>
            )}
          </If>
        }
      >
        {(message) => (
          <View role="alert" testID="activity-error" class="flex-row items-center gap-3">
            <Text class="text-sm text-destructive flex-1">{`Activity unavailable: ${message()}`}</Text>
            <Button
              testID="activity-retry"
              variant="outline"
              size="sm"
              loading={activityCards.loading()}
              onPress={reloadActivityCards}
            >
              Retry
            </Button>
          </View>
        )}
      </If>
    </View>
  );
}
