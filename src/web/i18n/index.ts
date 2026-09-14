/**
 * i18n layer. Every user-visible string goes through `t(key, params)`. Dictionaries are flat
 * JSON files (`en.json` is the reference; `ru.json` mirrors its keys). Missing keys fall back
 * to English, then to the key itself.
 */
import { computed, signal } from "@preact/signals";
import { type Dictionary, type Params, pickLanguage, translate } from "../lib/i18n-core.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import en from "./en.json";
import ru from "./ru.json";

export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

const dictionaries: Record<Language, Dictionary> = { en, ru };

function initialLanguage(): Language {
  const stored = readStored<string | null>("lang", null);
  if (stored && (LANGUAGES as readonly string[]).includes(stored)) return stored as Language;
  const candidates =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  return pickLanguage(LANGUAGES, candidates, "en");
}

export const language = signal<Language>(initialLanguage());

/** `Intl` locale for dates and relative times. */
export const locale = computed(() => (language.value === "ru" ? "ru-RU" : "en-US"));

export function setLanguage(next: Language): void {
  language.value = next;
  writeStored("lang", next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

export function toggleLanguage(): void {
  setLanguage(language.value === "en" ? "ru" : "en");
}

/** Translate `key` in the current language (reactive when called inside a component). */
export function t(key: string, params?: Params): string {
  return translate(key, params, dictionaries[language.value], en);
}

/**
 * Plural-aware `t`: picks `<key>.<form>` for `count` with `Intl.PluralRules` of the current
 * language (`one`, `few`, `many`, `other`), falling back to `<key>.other`. `count` is passed as
 * `{count}`, formatted for the locale (`1.5` → `1,5` in Russian).
 */
export function tn(key: string, count: number, params?: Params): string {
  const form = new Intl.PluralRules(locale.value).select(count);
  const dict = dictionaries[language.value];
  const formKey = dict[`${key}.${form}`] !== undefined ? `${key}.${form}` : `${key}.other`;
  const formatted = new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(count);
  return translate(formKey, { ...params, count: formatted }, dict, en);
}

/** Translate if a key exists, else return `fallback` (for open vocabularies like statuses). */
export function tOr(key: string, fallback: string, params?: Params): string {
  const dict = dictionaries[language.value];
  if (dict[key] === undefined && (en as Dictionary)[key] === undefined) return fallback;
  return translate(key, params, dict, en);
}

if (typeof document !== "undefined") document.documentElement.lang = language.value;
