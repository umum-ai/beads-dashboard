/** UI preferences persisted in localStorage (`bddb.*`): theme, actor, column widths, sections, lanes. */
import { effect, signal } from "@preact/signals";
import { readStored, writeStored } from "../lib/storage.ts";

export type Theme = "light" | "dark";

function systemTheme(): Theme {
  if (typeof matchMedia === "undefined") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Explicit choice or null (follow the system). */
export const themePref = signal<Theme | null>(readStored<Theme | null>("theme", null));
export const theme = signal<Theme>(themePref.value ?? systemTheme());

export function setTheme(next: Theme): void {
  themePref.value = next;
  theme.value = next;
  writeStored("theme", next);
}

export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

if (typeof matchMedia !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themePref.value === null) theme.value = systemTheme();
  });
}

if (typeof document !== "undefined") {
  effect(() => {
    document.documentElement.dataset.theme = theme.value;
  });
}

/** Actor for writes; null means "use meta.actorDefault". */
export const actorPref = signal<string | null>(readStored<string | null>("actor", null));

export function setActor(next: string | null): void {
  const trimmed = next?.trim() || null;
  actorPref.value = trimmed;
  writeStored("actor", trimmed);
}

export const DEFAULT_COLUMN_WIDTH = 288;
export const MIN_COLUMN_WIDTH = 200;
export const MAX_COLUMN_WIDTH = 640;

export const columnWidths = signal<Record<string, number>>(readStored("columnWidths", {}));

export function setColumnWidth(status: string, width: number): void {
  const clamped = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
  columnWidths.value = { ...columnWidths.value, [status]: clamped };
  writeStored("columnWidths", columnWidths.value);
}

/** Collapsed priority sections keyed `${status}:${priority}`. */
export const collapsedSections = signal<Record<string, true>>(readStored("collapsed", {}));

export function toggleSection(status: string, priority: number): void {
  const key = `${status}:${priority}`;
  const next = { ...collapsedSections.value };
  if (next[key]) delete next[key];
  else next[key] = true;
  collapsedSections.value = next;
  writeStored("collapsed", next);
}

export function isSectionCollapsed(status: string, priority: number): boolean {
  return collapsedSections.value[`${status}:${priority}`] === true;
}

export const dismissedVersionWarning = signal<string | null>(
  readStored<string | null>("dismissedVersionWarning", null),
);

export function dismissVersionWarning(text: string): void {
  dismissedVersionWarning.value = text;
  writeStored("dismissedVersionWarning", text);
}

/** Board grouping: swimlanes per top epic (default) or the flat board. */
export const groupByEpic = signal<boolean>(readStored("groupByEpic", true));

export function setGroupByEpic(next: boolean): void {
  groupByEpic.value = next;
  writeStored("groupByEpic", next);
}

/** Collapsed swimlanes keyed by epic id (`""` is the "no epic" lane). */
export const collapsedLanes = signal<Record<string, true>>(readStored("collapsedLanes", {}));

export function toggleLane(key: string): void {
  const next = { ...collapsedLanes.value };
  if (next[key]) delete next[key];
  else next[key] = true;
  collapsedLanes.value = next;
  writeStored("collapsedLanes", next);
}

export function isLaneCollapsed(key: string): boolean {
  return collapsedLanes.value[key] === true;
}
