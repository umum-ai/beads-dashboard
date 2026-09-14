/**
 * WCAG 2.x contrast arithmetic over the CSS tokens (`styles/tokens.css`). Pure; used by the
 * unit test that keeps every text/background pair of both themes at AA, and by nothing at
 * runtime.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` / `#rrggbb` → channels 0–255; anything else is `null`. */
export function parseHex(text: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m?.[1]) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.x. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Contrast ratio 1–21 between two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `fg` (with `alpha`) over `bg`. */
export function blend(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

export type Theme = "light" | "dark";

/**
 * Extract `--name: #hex;` declarations per theme from the tokens stylesheet. Light tokens live
 * in `:root { … }`, dark ones in `:root[data-theme="dark"] { … }`; dark inherits light values it
 * does not override.
 */
export function parseTokens(css: string): Record<Theme, Record<string, string>> {
  const blocks = [...css.matchAll(/(:root(?:\[data-theme="dark"\])?)\s*\{([^}]*)\}/g)];
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const block of blocks) {
    const target = block[1]?.includes("dark") ? dark : light;
    for (const decl of (block[2] ?? "").matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
      if (decl[1] && decl[2]) target[decl[1]] = decl[2].toLowerCase();
    }
  }
  return { light, dark: { ...light, ...dark } };
}

export interface Pair {
  /** Token name (without `--`) or a literal `#hex`. */
  fg: string;
  bg: string;
  /** Required ratio; 4.5 for body text (AA), 3 for large text and UI graphics. */
  min: number;
  /** What the pair is, for the report. */
  where: string;
}

export interface PairResult extends Pair {
  theme: Theme;
  ratio: number;
  ok: boolean;
}

export function resolveColor(tokens: Record<string, string>, ref: string): Rgb {
  const text = ref.startsWith("#") ? ref : tokens[ref];
  const rgb = text ? parseHex(text) : null;
  if (!rgb) throw new Error(`unknown colour ${ref}`);
  return rgb;
}

export function checkPairs(
  tokens: Record<Theme, Record<string, string>>,
  pairs: readonly Pair[],
): PairResult[] {
  const out: PairResult[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const pair of pairs) {
      const ratio = contrastRatio(
        resolveColor(tokens[theme], pair.fg),
        resolveColor(tokens[theme], pair.bg),
      );
      out.push({ ...pair, theme, ratio, ok: ratio >= pair.min });
    }
  }
  return out;
}
