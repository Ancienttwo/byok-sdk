import { mount, signal, Text, View } from "nsh";
import { openAllowedExternalUrl } from "../../links.ts";
import { MarkdownView } from "../../ui/index.ts";

/** Test entry: a `MarkdownView` whose link presses go through the `links.ts` gate with a test allowlist. */
const ALLOWED = ["https://docs.byok.test"];
const outcome = signal("none");

mount(() => (
  <View class="p-4 gap-2">
    <MarkdownView
      testID="links-md"
      markdown={"[docs](https://docs.byok.test/guide)\n\n[other](https://other.byok.test/guide)\n\n[plain](http://docs.byok.test/guide)\n\n[script](javascript:alert(1))"}
      onLinkPress={(url) => {
        void openAllowedExternalUrl(url, ALLOWED).then((opened) => outcome.set(`${opened ? "opened" : "refused"} ${url}`));
      }}
    />
    <Text testID="links-outcome">{outcome()}</Text>
  </View>
));
