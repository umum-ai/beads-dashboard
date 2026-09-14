/**
 * Every text/background pairing the stylesheet actually uses must meet WCAG AA in both themes:
 * 4.5:1 for text, 3:1 for the large/bold chips and the graphical accents. The pairs mirror
 * `src/web/styles/app.css`; add a row when a new colour combination appears.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkPairs,
  contrastRatio,
  type Pair,
  parseHex,
  parseTokens,
} from "../../../src/web/lib/contrast.ts";

const css = readFileSync(
  fileURLToPath(new URL("../../../src/web/styles/tokens.css", import.meta.url)),
  "utf8",
);
const tokens = parseTokens(css);

/** Text 4.5:1; small bold chips (10–11 px) are still "normal" text → 4.5 as well. */
const TEXT = 4.5;
/** Non-text UI (rails, stripes, dots, outlines) → 3:1. */
const GRAPHIC = 3;

const PAIRS: Pair[] = [
  { fg: "ink", bg: "canvas", min: TEXT, where: "body text on the page" },
  { fg: "ink", bg: "surface", min: TEXT, where: "body text on cards, drawer, dialogs" },
  { fg: "ink", bg: "surface-2", min: TEXT, where: "column heading" },
  { fg: "ink", bg: "surface-3", min: TEXT, where: "chip text, hovered controls" },
  { fg: "ink-2", bg: "surface", min: TEXT, where: "secondary text on cards, .chip" },
  { fg: "ink-2", bg: "surface-2", min: TEXT, where: "section heads, filter help" },
  { fg: "ink-2", bg: "surface-3", min: TEXT, where: ".chip on hovered rows" },
  { fg: "ink-2", bg: "canvas", min: TEXT, where: "empty-state body" },
  { fg: "ink-3", bg: "surface", min: TEXT, where: "counts, timestamps, hints on cards" },
  { fg: "ink-3", bg: "surface-2", min: TEXT, where: "column count, closed-window hint" },
  { fg: "ink-3", bg: "canvas", min: TEXT, where: "loading state" },
  { fg: "accent", bg: "surface", min: TEXT, where: "links" },
  { fg: "accent", bg: "surface-2", min: TEXT, where: "links inside columns" },
  { fg: "accent", bg: "canvas", min: TEXT, where: "links in banners / empty states" },
  { fg: "accent-ink", bg: "accent", min: TEXT, where: "primary button" },
  { fg: "danger-ink", bg: "danger", min: TEXT, where: "danger button, error toast" },
  { fg: "canvas", bg: "ink", min: TEXT, where: "info toast" },
  { fg: "ok", bg: "ok-soft", min: TEXT, where: ".chip--ok" },
  { fg: "warn", bg: "warn-soft", min: TEXT, where: ".banner (version warning)" },
  { fg: "danger", bg: "danger-soft", min: TEXT, where: ".chip--blocked, live indicator danger" },
  { fg: "danger", bg: "surface", min: TEXT, where: "error text, remove buttons" },
  { fg: "warn", bg: "surface", min: TEXT, where: "warning text" },
  { fg: "ok", bg: "surface", min: TEXT, where: "success text" },
  { fg: "focus", bg: "surface", min: GRAPHIC, where: "focus ring on white" },
  { fg: "focus", bg: "canvas", min: GRAPHIC, where: "focus ring on the page" },
  { fg: "focus", bg: "surface-2", min: GRAPHIC, where: "focus ring inside columns" },
];

// Priority chips: solid (`.pchip`: theme ink on the priority colour) and outline (`.pchip--outline`:
// the priority colour as text on the surfaces it sits on); rails and dots as graphics.
for (const p of ["p0", "p1", "p2", "p3", "p4"]) {
  PAIRS.push({ fg: "pchip-ink", bg: p, min: TEXT, where: `.pchip ${p} solid` });
  PAIRS.push({ fg: p, bg: "surface", min: TEXT, where: `.pchip--outline ${p} on cards` });
  PAIRS.push({ fg: p, bg: "surface-2", min: TEXT, where: `.pchip--outline ${p} in section heads` });
  PAIRS.push({ fg: p, bg: "canvas", min: GRAPHIC, where: `${p} lane rail on the page` });
}
for (const c of ["cat-active", "cat-wip", "cat-frozen", "cat-done"]) {
  PAIRS.push({ fg: c, bg: "surface-2", min: GRAPHIC, where: `${c} column stripe` });
  PAIRS.push({ fg: c, bg: "canvas", min: GRAPHIC, where: `${c} on the page` });
}

describe("contrast arithmetic", () => {
  test("parses hex and reproduces the WCAG reference ratios", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#1a1e25")).toEqual({ r: 26, g: 30, b: 37 });
    expect(parseHex("red")).toBeNull();
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 118, g: 118, b: 118 }, white)).toBeCloseTo(4.54, 2);
  });

  test("tokens.css defines both palettes with the tokens the pairs use", () => {
    expect(Object.keys(tokens.light).length).toBeGreaterThan(20);
    for (const pair of PAIRS) {
      for (const ref of [pair.fg, pair.bg]) {
        if (!ref.startsWith("#")) {
          expect(tokens.light[ref], `light --${ref}`).toBeDefined();
          expect(tokens.dark[ref], `dark --${ref}`).toBeDefined();
        }
      }
    }
  });
});

describe("WCAG AA in both themes", () => {
  const results = checkPairs(tokens, PAIRS);
  for (const result of results) {
    test(`${result.theme}: ${result.where} (--${result.fg} on --${result.bg}) ≥ ${result.min}:1`, () => {
      expect(result.ratio, `${result.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(result.min);
    });
  }
});
