/** Presentation lookups for open vocabularies: type glyphs, status/category tokens. */

const TYPE_GLYPHS: Record<string, string> = {
  task: "☐",
  bug: "✕",
  feature: "✦",
  chore: "⚙",
  epic: "◈",
  decision: "◆",
  spike: "⚡",
  story: "☰",
  milestone: "⚑",
};

/** Glyph for an issue type; unknown types share a neutral dot. */
export function typeGlyph(type: string | undefined): string {
  return TYPE_GLYPHS[type ?? ""] ?? "•";
}

export const KNOWN_TYPES = Object.keys(TYPE_GLYPHS);
