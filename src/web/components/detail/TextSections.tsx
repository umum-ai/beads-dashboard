/**
 * Markdown text fields of the drawer (`description`, `design`, `acceptance_criteria`, `notes`):
 * rendered read-only with an Edit button; editing swaps in the markdown editor with Save /
 * Cancel. Notes also offer Append (`append_notes`). While an editor is open the drawer holds
 * its revision, so a concurrent write surfaces as the conflict dialog on Save.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import type { IssueDetails, IssuePatch } from "../../lib/bff-types.ts";
import { renderMarkdown } from "../../lib/markdown.ts";
import { MarkdownEditor } from "../editors/MarkdownEditor.tsx";
import type { Editor } from "./editor.ts";

type TextKey = "description" | "design" | "acceptance_criteria" | "notes";

const SECTIONS: Array<{ key: TextKey; title: string }> = [
  { key: "description", title: "detail.section.description" },
  { key: "design", title: "detail.section.design" },
  { key: "acceptance_criteria", title: "detail.section.acceptance" },
  { key: "notes", title: "detail.section.notes" },
];

function TextSection({
  d,
  editor,
  field,
  title,
}: {
  d: IssueDetails;
  editor: Editor;
  field: TextKey;
  title: string;
}): JSX.Element {
  const [mode, setMode] = useState<"view" | "edit" | "append">("view");
  const [draft, setDraft] = useState("");
  const source = d[field] ?? "";

  const open = (next: "edit" | "append") => {
    setDraft(next === "edit" ? source : "");
    setMode(next);
    editor.beginEdit();
  };
  const finish = () => {
    setMode("view");
    editor.endEdit();
  };
  const save = async () => {
    const patch: IssuePatch =
      mode === "append" ? { append_notes: draft } : ({ [field]: draft } as IssuePatch);
    if (mode === "append" && !draft.trim()) return finish();
    if (mode === "edit" && draft === source) return finish();
    if ((await editor.save(patch)) !== "failed") finish();
  };

  return (
    <section
      class={`drawer__section text-section${source || mode !== "view" ? "" : " text-section--empty"}`}
      data-testid={`section-${field}`}
    >
      <div class="text-section__head">
        <h3 class="drawer__h">{title}</h3>
        {mode === "view" ? (
          <span class="text-section__tools">
            {field === "notes" ? (
              <button
                type="button"
                class="btn btn--ghost"
                data-testid={`append-${field}`}
                onClick={() => open("append")}
              >
                {t("detail.append")}
              </button>
            ) : null}
            <button
              type="button"
              class="btn btn--ghost"
              data-testid={`edit-${field}`}
              onClick={() => open("edit")}
            >
              {source ? t("detail.edit") : t("detail.add")}
            </button>
          </span>
        ) : null}
      </div>
      {mode === "view" ? (
        source ? (
          <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
        ) : (
          <p class="empty-note">{t("detail.text.empty")}</p>
        )
      ) : (
        <div class="text-section__editor">
          {mode === "append" && source ? (
            <div
              class="md text-section__existing"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
            />
          ) : null}
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSubmit={() => void save()}
            rows={mode === "append" ? 4 : 10}
            label={title}
            placeholder={mode === "append" ? t("detail.append.placeholder") : undefined}
            testId={`editor-${field}`}
            autoFocus
          />
          <div class="text-section__actions">
            <button type="button" class="btn btn--ghost" onClick={finish}>
              {t("dialog.cancel")}
            </button>
            <button
              type="button"
              class="btn btn--primary"
              disabled={editor.saving}
              data-testid={`save-${field}`}
              onClick={() => void save()}
            >
              {mode === "append" ? t("detail.append") : t("detail.save")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function TextSections({ d, editor }: { d: IssueDetails; editor: Editor }): JSX.Element {
  return (
    <>
      {SECTIONS.map((s) => (
        <TextSection key={s.key} d={d} editor={editor} field={s.key} title={t(s.title)} />
      ))}
    </>
  );
}
