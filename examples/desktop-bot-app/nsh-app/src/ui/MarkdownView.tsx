import { Text } from "nsh";
import { TextView } from "nsh/base";
import { openAllowedExternalUrl } from "../links.ts";
import { platformInputFont } from "./Input.tsx";

export interface MarkdownViewProps {
  markdown: string;
  /** The text is still arriving: syntax its end leaves open shows as if closed. */
  streaming?: boolean;
  selectable?: boolean;
  /** Shows a static caret after the last block (a streaming reply's). */
  streamingCaret?: boolean;
  testID?: string;
  /** Receives every pressed link; defaults to the `links.ts` allowlist gate. Injectable for tests. */
  onLinkPress?: (url: string) => void;
}

/**
 * Markdown through `nsh/base` `TextView`. Links are always `"report"`, never `"open"` (ADR-052 D2): a press reaches
 * `onLinkPress` only, so the `links.ts` allowlist stays the single gate before `openUrl`. No prop changes that.
 */
export function MarkdownView(props: MarkdownViewProps) {
  return (
    <TextView
      testID={props.testID}
      markdown={props.markdown}
      options={{ streaming: Boolean(props.streaming) }}
      selectable={Boolean(props.selectable)}
      links="report"
      streamingCaret={props.streamingCaret ? <Text class="text-muted-foreground">▍</Text> : undefined}
      onLinkPress={(event) => {
        if (props.onLinkPress) {
          props.onLinkPress(event.url);
        } else {
          void openAllowedExternalUrl(event.url);
        }
      }}
      class={platformInputFont()}
    />
  );
}
