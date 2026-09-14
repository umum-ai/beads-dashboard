/** Dictionary lookup with `{param}` interpolation and a fallback chain; no signals here. */

export type Dictionary = Record<string, string>;
export type Params = Record<string, string | number>;

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Look `key` up in `primary`, then in each fallback dictionary; when nothing has it, return
 * the key itself so a missing translation is visible rather than blank.
 */
export function translate(
  key: string,
  params: Params | undefined,
  primary: Dictionary,
  ...fallbacks: Dictionary[]
): string {
  const template = primary[key] ?? fallbacks.find((d) => d[key] !== undefined)?.[key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** Pick the supported language matching `navigator.language` ("ru-RU" is "ru"), else default. */
export function pickLanguage<L extends string>(
  supported: readonly L[],
  candidates: readonly string[],
  fallback: L,
): L {
  for (const candidate of candidates) {
    const short = candidate.toLowerCase().split(/[-_]/)[0];
    const hit = supported.find((l) => l.toLowerCase() === short);
    if (hit) return hit;
  }
  return fallback;
}
