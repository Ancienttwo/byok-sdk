import { signal, Text, View } from "nsh";
import { languageOptions, languagePreference, saveLanguagePreference, t } from "../../i18n.ts";
import { Card, CardContent, CardHeader, CardTitle, Select } from "../../ui/index.ts";

export function LanguageSetting(props: { loadFailed: boolean }) {
  const saving = signal(false);
  const saveFailed = signal(false);

  const change = async (value: string | null) => {
    if (saving()) return;
    saving.set(true);
    saveFailed.set(false);
    try {
      await saveLanguagePreference(value);
    } catch {
      saveFailed.set(true);
    } finally {
      saving.set(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("language.general")}</CardTitle>
      </CardHeader>
      <CardContent>
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <Text class="text-sm text-foreground">{t("language.label")}</Text>
          <Select
            testID="settings-language"
            accessibilityLabel={t("language.label")}
            items={languageOptions()}
            value={languagePreference() ?? "system"}
            disabled={saving() || (languagePreference() === undefined && !props.loadFailed)}
            onChange={(value) => void change(value)}
          />
        </View>
        <If when={props.loadFailed && languagePreference() === undefined}>
          <Text role="alert" class="text-xs text-destructive">{t("language.loadError")}</Text>
        </If>
        <If when={saveFailed()}>
          <Text role="alert" class="text-xs text-destructive">{t("language.saveError")}</Text>
        </If>
      </CardContent>
    </Card>
  );
}
