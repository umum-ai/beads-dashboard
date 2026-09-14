import { describe, expect, test } from "bun:test";
import en from "../../../src/web/i18n/en.json";
import ru from "../../../src/web/i18n/ru.json";
import { interpolate, pickLanguage, translate } from "../../../src/web/lib/i18n-core.ts";

describe("i18n core", () => {
  test("interpolates {params} and leaves unknown placeholders visible", () => {
    expect(interpolate("{shown} of {total} shown", { shown: 3, total: 10 })).toBe("3 of 10 shown");
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
    expect(interpolate("plain", undefined)).toBe("plain");
  });

  test("falls back from the primary dictionary to English, then to the key", () => {
    const primary = { "a.b": "первичный" };
    const fallback = { "a.b": "primary", "only.en": "english {x}" };
    expect(translate("a.b", undefined, primary, fallback)).toBe("первичный");
    expect(translate("only.en", { x: 1 }, primary, fallback)).toBe("english 1");
    expect(translate("missing.key", undefined, primary, fallback)).toBe("missing.key");
  });

  test("picks the language from navigator-style candidates", () => {
    const supported = ["en", "ru"] as const;
    expect(pickLanguage(supported, ["ru-RU", "en-US"], "en")).toBe("ru");
    expect(pickLanguage(supported, ["de-DE", "en-GB"], "en")).toBe("en");
    expect(pickLanguage(supported, ["de-DE"], "en")).toBe("en");
    expect(pickLanguage(supported, [], "en")).toBe("en");
    expect(pickLanguage(supported, ["RU"], "en")).toBe("ru");
  });
});

describe("dictionaries", () => {
  const enKeys = Object.keys(en).sort();
  const ruKeys = Object.keys(ru).sort();

  test("ru.json has exactly the keys of en.json", () => {
    expect(ruKeys).toEqual(enKeys);
  });

  test("no empty strings", () => {
    for (const [key, value] of Object.entries({ ...en, ...ru })) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  test("placeholders agree between languages", () => {
    const params = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of enKeys) {
      expect(params((ru as Record<string, string>)[key] ?? ""), key).toEqual(
        params((en as Record<string, string>)[key] ?? ""),
      );
    }
  });
});
