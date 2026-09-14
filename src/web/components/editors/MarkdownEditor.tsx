/**
 * Markdown editor: a textarea with Write / Preview tabs (preview through the same marked +
 * DOMPurify renderer the drawer uses). Controlled: the parent owns the value. Ctrl/Cmd+Enter
 * submits through `onSubmit` when given.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { renderMarkdown } from "../../lib/markdown.ts";

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (() => void) | undefined;
  rows?: number | undefined;
  placeholder?: string | undefined;
  label: string;
  testId?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

export function MarkdownEditor(props: MarkdownEditorProps): JSX.Element {
  const [tab, setTab] = useState<"write" | "preview">("write");
  return (
    <div class="mde" data-testid={props.testId}>
      <div class="mde__tabs" role="tablist" aria-label={props.label}>
        <button
          type="button"
          role="tab"
          class="mde__tab"
          aria-selected={tab === "write"}
          onClick={() => setTab("write")}
        >
          {t("mde.write")}
        </button>
        <button
          type="button"
          role="tab"
          class="mde__tab"
          aria-selected={tab === "preview"}
          data-testid="mde-preview-tab"
          onClick={() => setTab("preview")}
        >
          {t("mde.preview")}
        </button>
        <span class="mde__hint">{t("mde.hint")}</span>
      </div>
      {tab === "write" ? (
        <textarea
          class="input mde__text"
          rows={props.rows ?? 8}
          value={props.value}
          placeholder={props.placeholder}
          aria-label={props.label}
          disabled={props.disabled}
          // biome-ignore lint/a11y/noAutofocus: the editor opens on demand
          autoFocus={props.autoFocus}
          data-testid="mde-text"
          onInput={(e) => props.onChange((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && props.onSubmit) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
      ) : (
        <div class="mde__preview" data-testid="mde-preview">
          {props.value.trim() ? (
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(props.value) }} />
          ) : (
            <p class="empty-note">{t("mde.empty")}</p>
          )}
        </div>
      )}
    </div>
  );
}
