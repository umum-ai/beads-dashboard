/**
 * Hierarchy section of the detail drawer: the parent chain as breadcrumbs and the direct
 * children from the snapshot, then the dependency tree fetched from
 * `GET dependencies/tree?root_id=<id>&direction=both&max_depth=3`. The tree answer is a flat
 * DFS pre-order list: for `both` it is every "up" node (what depends on the root) followed by
 * the root and its "down" subtree (what the root depends on); it is rendered as two indented
 * lists using `depth`, with `edge_from_parent` as the edge label (`parent-child` edges are the
 * hierarchy and are labelled parent / child).
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t, tOr } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import type { BoardIssue, TreeNode } from "../lib/bff-types.ts";
import { clampPriority } from "../lib/board.ts";
import { ancestorsOf, childrenOf } from "../lib/hierarchy.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { hrefFor, navigate } from "../state/route.ts";
import { hierarchy } from "../state/snapshot.ts";
import { describeError } from "../state/toasts.ts";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs.tsx";
import { statusLabel } from "./Column.tsx";

export const TREE_DEPTH = 3;

interface TreeRowProps {
  db: string;
  id: string;
  title: string;
  status?: string | undefined;
  type?: string | undefined;
  priority?: number | undefined;
  blocked?: boolean | undefined;
  edge?: string | undefined;
  hierarchyEdge?: boolean | undefined;
  depth?: number | undefined;
  current?: boolean | undefined;
}

export function TreeRow(props: TreeRowProps): JSX.Element {
  const target = { kind: "issue" as const, db: props.db, issueId: props.id };
  const p = props.priority === undefined ? null : clampPriority(props.priority);
  return (
    <li
      class={`trow${props.current ? " trow--current" : ""}`}
      style={props.depth ? { paddingLeft: `${props.depth * 16}px` } : undefined}
      data-id={props.id}
    >
      <a
        class="rel"
        href={hrefFor(target)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          if (!props.current) navigate(target);
        }}
        aria-current={props.current ? "true" : undefined}
      >
        <span aria-hidden="true">{typeGlyph(props.type)}</span>
        <span class="mono">{props.id}</span>
        <span class="rel__title ellipsis" title={props.title}>
          {props.title}
        </span>
        {props.blocked ? (
          <span class="chip chip--blocked" title={t("card.blocked.help")}>
            {t("card.blocked")}
          </span>
        ) : null}
        {props.edge ? (
          <span class={`rel__kind${props.hierarchyEdge ? " rel__kind--hier" : ""}`}>
            {props.edge}
          </span>
        ) : null}
        {p !== null ? (
          <span class="pchip pchip--outline" data-priority={p}>
            {t(`priority.${p}`)}
          </span>
        ) : null}
        <span class="rel__status">{statusLabel(props.status ?? "open")}</span>
      </a>
    </li>
  );
}

function edgeLabel(node: TreeNode, up: boolean): { label: string; hierarchy: boolean } {
  const kind = node.edge_from_parent ?? "";
  if (kind === "parent-child") {
    // down walks child → parent (the node is the parent); up walks parent → child
    return { label: t(up ? "detail.tree.edge.child" : "detail.tree.edge.parent"), hierarchy: true };
  }
  return { label: tOr(`dep.${kind}`, kind), hierarchy: false };
}

type TreeState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; up: TreeNode[]; down: TreeNode[] };

export function DependencyTree({ db, id }: { db: string; id: string }): JSX.Element {
  const [state, setState] = useState<TreeState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .tree(db, id, "both", TREE_DEPTH)
      .then((page) => {
        if (cancelled) return;
        // `both` = every up node (except the root), then the root and its down subtree.
        const items = page.items ?? [];
        const rootAt = items.findIndex((n) => n.id === id && n.depth === 0);
        const up = rootAt === -1 ? items : items.slice(0, rootAt);
        const down = rootAt === -1 ? [] : items.slice(rootAt + 1);
        setState({ kind: "ready", up, down });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [db, id, attempt]);

  if (state.kind === "loading") {
    return (
      <p class="empty-note" data-testid="detail-tree-loading">
        {t("detail.tree.loading")}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div class="tree-error" data-testid="detail-tree-error">
        <p class="empty-note">{describeError(state.error)}</p>
        <button type="button" class="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
          {t("state.retry")}
        </button>
      </div>
    );
  }
  if (state.up.length === 0 && state.down.length === 0) {
    return (
      <p class="empty-note" data-testid="detail-tree-empty">
        {t("detail.tree.empty")}
      </p>
    );
  }
  const list = (nodes: TreeNode[], up: boolean, testId: string) => (
    <ul class="rel-list tree" data-testid={testId}>
      {nodes.map((node, i) => {
        const edge = edgeLabel(node, up);
        return (
          <TreeRow
            key={`${up ? "u" : "d"}:${node.id}:${i}`}
            db={db}
            id={node.id}
            title={node.title}
            status={node.status}
            type={node.issue_type}
            priority={node.priority}
            edge={edge.label}
            hierarchyEdge={edge.hierarchy}
            depth={Math.max(0, node.depth - 1)}
          />
        );
      })}
    </ul>
  );
  return (
    <div class="tree-wrap" data-testid="detail-tree">
      {state.up.length ? (
        <>
          <h4 class="tree__h">{t("detail.tree.dependents", { count: state.up.length })}</h4>
          {list(state.up, true, "detail-tree-up")}
        </>
      ) : null}
      {state.down.length ? (
        <>
          <h4 class="tree__h">{t("detail.tree.dependencies", { count: state.down.length })}</h4>
          {list(state.down, false, "detail-tree-down")}
        </>
      ) : null}
      <p class="tree__note">{t("detail.tree.depthNote", { depth: TREE_DEPTH })}</p>
    </div>
  );
}

export interface HierarchySectionProps {
  db: string;
  id: string;
  /** The drawer's row when the snapshot has it (title for the current crumb). */
  row: BoardIssue | undefined;
  title: string;
}

export function HierarchySection({ db, id, row, title }: HierarchySectionProps): JSX.Element {
  const index = hierarchy.value;
  const ancestors = ancestorsOf(index, id);
  const children = childrenOf(index, id);
  const crumbs: Crumb[] = [
    ...ancestors.map((a) => ({
      key: a.id,
      id: a.id,
      label: a.title,
      title: a.title,
      href: hrefFor({ kind: "issue", db, issueId: a.id }),
      onSelect: () => navigate({ kind: "issue", db, issueId: a.id }),
    })),
    { key: id, id, label: row?.title ?? title, title: row?.title ?? title },
  ];
  return (
    <section class="drawer__section" data-testid="detail-hierarchy">
      <h3 class="drawer__h">{t("detail.section.hierarchy")}</h3>
      {ancestors.length ? (
        <Breadcrumbs
          items={crumbs}
          label={t("detail.hierarchy.path")}
          testId="detail-crumbs"
          small
        />
      ) : null}
      <h4 class="tree__h">{t("detail.section.children", { count: children.length })}</h4>
      {children.length ? (
        <ul class="rel-list" data-testid="detail-children">
          {children.map((child) => (
            <li key={child.id} data-id={child.id}>
              <button
                type="button"
                class="rel"
                onClick={() => navigate({ kind: "issue", db, issueId: child.id })}
              >
                <span aria-hidden="true">{typeGlyph(child.issue_type)}</span>
                <span class="mono">{child.id}</span>
                <span class="rel__title ellipsis" title={child.title}>
                  {child.title}
                </span>
                {child.blocked ? (
                  <span class="chip chip--blocked" title={t("card.blocked.help")}>
                    {t("card.blocked")}
                  </span>
                ) : null}
                <span class="pchip pchip--outline" data-priority={clampPriority(child.priority)}>
                  {t(`priority.${clampPriority(child.priority)}`)}
                </span>
                <span class="rel__status">{statusLabel(child.status ?? "open")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="empty-note">{t("detail.hierarchy.noChildren")}</p>
      )}
      <h4 class="tree__h">{t("detail.tree.title")}</h4>
      <DependencyTree db={db} id={id} />
    </section>
  );
}
