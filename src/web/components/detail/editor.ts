/**
 * Editing session of the detail drawer: guarded saves against the loaded `revision`, the
 * conflict dialog (reload / overwrite), and the "an editor is open" flag that pauses the silent
 * re-reads a live delta would otherwise trigger (so a save while someone else wrote conflicts
 * instead of silently adopting their revision).
 */
import { useCallback, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import type { IssueDetails, IssuePatch } from "../../lib/bff-types.ts";
import { patchGuarded } from "../../lib/mutations.ts";
import { ask } from "../../state/dialogs.ts";
import { actor } from "../../state/meta.ts";
import { pushToast, toastError } from "../../state/toasts.ts";

/** `saved`; `discarded` = the user chose Reload in the conflict dialog (editor should close); `failed`. */
export type SaveResult = "saved" | "discarded" | "failed";

export interface Editor {
  /** Guarded PATCH against the loaded revision; conflict → dialog (reload / overwrite). */
  save: (patch: IssuePatch) => Promise<SaveResult>;
  /** Number of open inline editors (title, text sections). */
  editing: number;
  beginEdit: () => void;
  endEdit: () => void;
  saving: boolean;
}

export function useEditor(
  db: string,
  id: string,
  details: IssueDetails | null,
  setDetails: (next: IssueDetails) => void,
  reload: () => void,
): Editor {
  const [editing, setEditing] = useState(0);
  const [saving, setSaving] = useState(false);
  const detailsRef = useRef(details);
  detailsRef.current = details;

  const save = useCallback(
    async (patch: IssuePatch, force = false): Promise<SaveResult> => {
      const current = detailsRef.current;
      if (!current) return "failed";
      setSaving(true);
      try {
        const result = await patchGuarded(db, id, actor.value, patch, {
          revision: force ? undefined : current.revision,
        });
        if (result.ok) {
          // `Issue.dependencies` (raw edges) must not replace the hydrated `IssueDetails` lists.
          const { dependencies: _edges, ...issue } = result.response.issue;
          const merged: IssueDetails = { ...current, ...issue, revision: result.response.revision };
          setDetails(merged);
          detailsRef.current = merged;
          return "saved";
        }
        if (result.kind === "conflict") {
          const choice = await ask({ kind: "conflict", id, title: current.title });
          if (!choice) return "failed";
          if (choice.choice === "reload") {
            reload();
            return "discarded";
          }
          return save(patch, true); // overwrite: re-read the revision and retry once
        }
        toastError(result.error);
        return "failed";
      } finally {
        setSaving(false);
      }
    },
    [db, id, setDetails, reload],
  );

  return {
    save: (patch) => save(patch),
    editing,
    beginEdit: () => setEditing((n) => n + 1),
    endEdit: () => setEditing((n) => Math.max(0, n - 1)),
    saving,
  };
}

export function toastSaved(): void {
  pushToast("success", t("toast.saved"), 1800);
}
