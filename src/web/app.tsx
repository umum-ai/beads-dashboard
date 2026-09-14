/** Application shell: meta bootstrap, route switching, live connection per database. */
import { useSignalEffect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { CreateIssueModal } from "./components/CreateIssueModal.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { DialogHost } from "./components/Dialog.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Header } from "./components/Header.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { VersionBanner } from "./components/VersionBanner.tsx";
import { t } from "./i18n/index.ts";
import { connectLive, disconnectLive } from "./lib/live.ts";
import { databases, loadMeta, meta, metaError, metaLoading } from "./state/meta.ts";
import { currentDb, navigate, route } from "./state/route.ts";
import { describeError } from "./state/toasts.ts";
import { BoardView } from "./views/BoardView.tsx";
import { EpicsView } from "./views/EpicsView.tsx";

export function App() {
  useEffect(() => {
    void loadMeta();
  }, []);

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
  if (metaError.value && !m) {
    content = (
      <EmptyState
        title={t("error.network_error")}
        body={describeError(metaError.value)}
        action={{ label: t("common.reload"), onClick: () => void loadMeta() }}
      />
    );
  } else if (!m || (metaLoading.value && r.kind === "home")) {
    content = <EmptyState loading title={t("board.loading")} />;
  } else if (m.databases.length === 0) {
    content = (
      <EmptyState title={t("state.noDatabases.title")} body={t("state.noDatabases.body")} />
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
  } else if (r.kind === "epics") {
    content = <EpicsView db={r.db} />;
  } else {
    content = <BoardView db={r.db} />;
  }

  return (
    <>
      <Header />
      <VersionBanner />
      <main class="main">
        {content}
        {r.kind === "issue" ? <DetailPanel db={r.db} id={r.issueId} /> : null}
      </main>
      {"db" in r ? <CreateIssueModal db={r.db} /> : null}
      <DialogHost />
      <Toasts />
    </>
  );
}
