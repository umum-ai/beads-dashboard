/**
 * "Keyboard shortcuts" dialog (`?` or the header button). One table, grouped by where the keys
 * work; the same list is documented in docs/ui.md.
 */
import { signal } from "@preact/signals";
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { trapFocus } from "../lib/focus-trap.ts";

export const helpOpen = signal(false);

export function openHelp(): void {
  helpOpen.value = true;
}

export function closeHelp(): void {
  helpOpen.value = false;
}

export function toggleHelp(): void {
  helpOpen.value = !helpOpen.value;
}

interface Row {
  keys: string[];
  label: string;
}

interface Group {
  title: string;
  rows: Row[];
}

/** Keys are shown as typed; labels come from i18n. */
export function shortcutGroups(): Group[] {
  return [
    {
      title: t("help.group.page"),
      rows: [
        { keys: ["/"], label: t("help.focusSearch") },
        { keys: ["n"], label: t("help.newIssue") },
        { keys: ["?"], label: t("help.showHelp") },
        { keys: ["Esc"], label: t("help.escape") },
      ],
    },
    {
      title: t("help.group.cards"),
      rows: [
        { keys: ["Tab"], label: t("help.tabCards") },
        { keys: ["↑", "↓"], label: t("help.arrowsColumn") },
        { keys: ["←", "→"], label: t("help.arrowsColumns") },
        { keys: ["Home", "End"], label: t("help.homeEnd") },
        { keys: ["Enter"], label: t("help.openCard") },
        { keys: ["Space"], label: t("help.cardMenu") },
        { keys: ["Shift+Space"], label: t("help.toggleSelect") },
      ],
    },
    {
      title: t("help.group.editing"),
      rows: [
        { keys: ["Ctrl+Enter"], label: t("help.submit") },
        { keys: ["Esc"], label: t("help.cancelEdit") },
        { keys: ["←", "→"], label: t("help.resize") },
      ],
    },
  ];
}

export function ShortcutsHelp(): JSX.Element | null {
  if (!helpOpen.value) return null;
  return <HelpDialog />;
}

function HelpDialog(): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const release = root.current ? trapFocus(root.current) : () => {};
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeHelp();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      release();
    };
  }, []);
  return (
    <div class="modal" data-testid="modal-backdrop">
      <button
        type="button"
        class="modal__backdrop"
        aria-label={t("dialog.cancel")}
        onClick={closeHelp}
      />
      <div
        ref={root}
        class="modal__panel modal__panel--help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        data-testid="help-dialog"
      >
        <h2 class="modal__title" id="help-title">
          {t("help.title")}
        </h2>
        <div class="help">
          {shortcutGroups().map((group) => (
            <section key={group.title} class="help__group">
              <h3 class="help__h">{group.title}</h3>
              <dl class="help__list">
                {group.rows.map((row) => (
                  <div key={row.label} class="help__row">
                    <dt class="help__keys">
                      {row.keys.map((key) => (
                        <kbd key={key} class="kbd">
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd class="help__label">{row.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div class="modal__actions">
          <button
            type="button"
            class="btn btn--primary"
            data-autofocus
            data-testid="help-close"
            onClick={closeHelp}
          >
            {t("help.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
