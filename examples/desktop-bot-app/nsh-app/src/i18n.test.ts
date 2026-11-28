import { addTranslations, t as translate } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { t } from "./i18n.ts";
import en from "../locales/en.json";
import hans from "../locales/zh-Hans.json";
import hant from "../locales/zh-Hant.json";
import gallery from "./features/gallery/translations.json";

const argumentsIn = (text: string) => [...text.matchAll(/%\{([^}]+)\}/g)].map((match) => match[1]).sort();

test("each translation has the English dictionary's keys and interpolation arguments", () => {
  const english: Readonly<Record<string, string>> = { ...en, ...gallery.en };
  const chinese: Readonly<Record<string, string>>[] = [
    { ...hans, ...gallery["zh-Hans"] },
    { ...hant, ...gallery["zh-Hant"] },
  ];
  for (const locale of chinese) {
    expect(Object.keys(locale).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(locale)) {
      expect(value.trim().length > 0).toBe(true);
      expect(argumentsIn(value)).toEqual(argumentsIn(english[key]!));
    }
  }
});

test("a missing translation uses English and an unknown key stays visible in development", () => {
  addTranslations({ en: { "test.englishOnly": "English text" } });
  expect(translate("test.englishOnly", { locale: "zh-Hans" })).toBe("English text");
  expect(t("test.unknown")).toBe("en.test.unknown");
});
