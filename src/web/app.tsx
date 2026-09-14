/**
 * Application shell: meta bootstrap, route switching, live connection per database, global
 * keyboard shortcuts (`lib/keyboard.ts`), banners, dialogs and toasts.
 */
import { useSignalEffect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { toggleSettings } from "./components/BoardSettings.tsx";
import { CreateIssueModal } from "./components/CreateIssueModal.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { DialogHost } from "./components/Dialog.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Header } from "./components/Header.tsx";
import { ShortcutsHelp, toggleHelp } from "./components/ShortcutsHelp.tsx";
import { ConnectionBanner, DatabaseBanner } from "./components/StatusBanners.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { VersionBanner } from "./components/VersionBanner.tsx";
import { t } from "./i18n/index.ts";
import { isEditableTarget, QUICK_FILTER_ID, resolveShortcut } from "./lib/keyboard.ts";
import { connectLive, disconnectLive } from "./lib/live.ts";
import { createRequest, openCreate } from "./state/create.ts";
import { dialog } from "./state/dialogs.ts";
import { databases, loadMeta, meta, metaError, metaLoading } from "./state/meta.ts";
import { currentDb, drawerOpen, filters, navigate, route } from "./state/route.ts";
import { describeError } from "./state/toasts.ts";
import { BoardView } from "./views/BoardView.tsx";
import { EpicsView } from "./views/EpicsView.tsx";

/** `/`, `n`, `?`, `,` on the page; dialogs handle their own Escape (capture phase) before this. */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = resolveShortcut(event, isEditableTarget(event.target as HTMLElement | null));
      if (!action || action === "escape") return;
      // A modal is open: let it own the keyboard.
      if (dialog.value || createRequest.value) return;
      const db = currentDb.value;
      switch (action) {
        case "focusSearch": {
          const input = document.getElementById(QUICK_FILTER_ID) as HTMLInputElement | null;
          if (!input) return;
          event.preventDefault();
          input.focus();
          input.select();
          return;
        }
        case "newIssue":
          if (!db || drawerOpen.value) return;
          event.preventDefault();
          openCreate(filters.value.epic ? { parent: filters.value.epic } : {});
          return;
        case "help":
          event.preventDefault();
          toggleHelp();
          return;
        case "settings":
          if (!db) return;
          event.preventDefault();
          toggleSettings();
          return;
        default:
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Things to check when the server lists no database — the same as `bddb doctor` prints. */
function noDatabaseHints(): string[] {
  return [
    t("state.noDatabases.hint.dolt"),
    t("state.noDatabases.hint.server"),
    t("state.noDatabases.hint.env"),
    t("state.hint.doctor"),
  ];
}

export function App() {
  useEffect(() => {
    void loadMeta();
  }, []);
  useGlobalShortcuts();

  // `/` (or an unknown db while meta is fresh) goes to the default database.
  useSignalEffect(() => {
    const m = meta.value;
    if (!m) return;
    const r = route.value;
    if (r.kind === "home" && m.defaultDatabase) {
      navigate({ kind: "board", db: m.defaultDatabase }, { replace: true });
    }
  });

  // One live stream per displayed database.
  useSignalEffect(() => {
    const db = currentDb.value;
    const known = databases.value.some((d) => d.name === db);
    if (db && (known || !meta.value)) connectLive(db);
    else disconnectLive();
  });

  const r = route.value;
  const m = meta.value;

  let content: preact.JSX.Element;
  let pageTitle = t("app.name");
  if (metaError.value && !m) {
    content = (
      <EmptyState
        tone="danger"
        title={t("state.metaFailed.title")}
        body={t("state.metaFailed.body")}
        detail={describeError(metaError.value)}
        hints={[t("state.metaFailed.hint.running"), t("state.metaFailed.hint.url")]}
        action={{ label: t("state.retry"), onClick: () => void loadMeta(), testId: "meta-retry" }}
        testId="meta-error"
      />
    );
  } else if (!m || (metaLoading.value && r.kind === "home")) {
    content = <EmptyState loading title={t("board.loading")} />;
  } else if (m.databases.length === 0) {
    content = (
      <EmptyState
        title={t("state.noDatabases.title")}
        body={t("state.noDatabases.body")}
        hints={noDatabaseHints()}
        action={{ label: t("common.reload"), onClick: () => location.reload() }}
        testId="no-databases"
      />
    );
  } else if (r.kind === "home") {
    content = <EmptyState loading title={t("board.loading")} />;
  } else if (r.kind === "unknown") {
    content = (
      <EmptyState
        title={t("state.notFound.title")}
        body={t("state.notFound.body")}
        action={{
          label: t("state.goBoard"),
          onClick: () => navigate({ kind: "board", db: m.defaultDatabase }),
        }}
      />
    );
  } else if (!m.databases.some((d) => d.name === r.db)) {
    content = (
      <EmptyState
        title={t("state.unknownDb.title")}
        body={t("state.unknownDb.body", { db: r.db })}
        action={{
          label: t("state.goBoard"),
          onClick: () => navigate({ kind: "board", db: m.defaultDatabase }),
        }}
      />
    );
  } else if (r.kind === "epics" || r.kind === "epicsIssue") {
    content = <EpicsView db={r.db} />;
  } else {
    pageTitle = `${t("nav.board")} — ${r.db}`;
    content = <BoardView db={r.db} />;
  }

  return (
    <>
      <Header />
      <ConnectionBanner />
      <VersionBanner />
      <DatabaseBanner />
      <main class="main">
        {r.kind === "epics" || r.kind === "epicsIssue" ? null : (
          <h1 class="sr-only">{pageTitle}</h1>
        )}
        {content}
        {r.kind === "issue" || r.kind === "epicsIssue" ? (
          <DetailPanel db={r.db} id={r.issueId} />
        ) : null}
      </main>
      {"db" in r ? <CreateIssueModal db={r.db} /> : null}
      <DialogHost />
      <ShortcutsHelp />
      <Toasts />
    </>
  );
}
