import { batch, locale, localeSettings, signal, Storage } from "nsh";
import { availableLocales, setLocale, t as translate } from "nsh/i18n";
import type { RoleLocale } from "../../src/host/conversation/catalog.ts";

const STORAGE_KEY = "language";
const LANGUAGE_NAMES: Record<RoleLocale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

type LanguagePreference = "system" | RoleLocale;
const preference = signal<LanguagePreference | undefined>(undefined);
export const languagePreference = () => preference();

function isAppLocale(value: string | null): value is RoleLocale {
  return value !== null && Object.hasOwn(LANGUAGE_NAMES, value);
}

export function languageOptions() {
  return [
    { value: "system", title: t("language.system") },
    ...availableLocales().filter(isAppLocale).map((value) => ({ value, title: LANGUAGE_NAMES[value] })),
  ];
}

export async function loadLanguagePreference(): Promise<void> {
  const saved = await Storage.getItem(STORAGE_KEY);
  applyLanguage(isAppLocale(saved) ? saved : "system");
}

export async function saveLanguagePreference(value: string | null): Promise<void> {
  if (value !== "system" && !isAppLocale(value)) return;
  await Storage.setItem(STORAGE_KEY, value);
  applyLanguage(value);
}

function applyLanguage(value: LanguagePreference): void {
  batch(() => {
    preference.set(value);
    setLocale(value === "system" ? null : value);
  });
}

/** NSH trims subtags during lookup, so regional Chinese tags also need a script match. */
function supportedLanguage(tag: string): RoleLocale | undefined {
  const [language, ...subtags] = tag.split("-");
  if (language === "en") return "en";
  if (language !== "zh") return undefined;
  if (subtags[0] === "Hant") return "zh-Hant";
  if (subtags[0] === "Hans") return "zh-Hans";
  return subtags.some((part) => part === "TW" || part === "HK" || part === "MO") ? "zh-Hant" : "zh-Hans";
}

export function appLocale(): RoleLocale {
  const selected = preference();
  if (selected !== undefined && selected !== "system") return selected;
  for (const tag of localeSettings().languages) {
    const supported = supportedLanguage(tag);
    if (supported !== undefined) return supported;
  }
  return supportedLanguage(locale()) ?? "en";
}

export function t(key: string, args?: Record<string, string>): string {
  const language = appLocale();
  const text = translate(key, { ...args, locale: language });
  return process.env.NODE_ENV === "production" && text === `${language}.${key}`
    ? translate("common.unavailable", { locale: "en" })
    : text;
}

function formattingLocale(): string {
  const selected = appLocale();
  const regional = locale();
  return supportedLanguage(regional) === selected ? regional : selected;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(formattingLocale(), options).format(value);
}

export function formatDate(value: number | string): string {
  return new Intl.DateTimeFormat(formattingLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
