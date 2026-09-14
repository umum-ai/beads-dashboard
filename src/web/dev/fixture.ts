/**
 * In-memory fixture for the mock BFF: two databases with realistic issues (epics with
 * children, `lane:*` labels, priorities 0..4, a blocked task, a few recently closed, one
 * custom status). Deterministic so e2e tests can name issues.
 */
import type { Comment, IssueDetails, IssueWithCounts, StatusDef } from "../lib/bff-types.ts";

export interface FixtureDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at: string;
}

export interface FixtureIssue extends IssueWithCounts {
  revision: string;
}

export interface FixtureDb {
  name: string;
  prefix: string;
  statuses: StatusDef[];
  types: string[];
  issues: Map<string, FixtureIssue>;
  dependencies: FixtureDependency[];
  comments: Map<string, Comment[]>;
  /** Id of the issue the live ticker mutates. */
  liveId: string | null;
}

const BUILTIN_STATUSES: StatusDef[] = [
  { name: "open", category: "active", builtin: true },
  { name: "in_progress", category: "wip", builtin: true },
  { name: "blocked", category: "wip", builtin: true },
  { name: "hooked", category: "wip", builtin: true },
  { name: "deferred", category: "frozen", builtin: true },
  { name: "pinned", category: "frozen", builtin: true },
  { name: "closed", category: "done", builtin: true },
];

const BUILTIN_TYPES = [
  "task",
  "bug",
  "feature",
  "chore",
  "epic",
  "decision",
  "spike",
  "story",
  "milestone",
];

/** Rows are dated relative to start-up so the closed window (7 days) keeps the same shape. */
export const FIXTURE_EPOCH = Math.floor(Date.now() / 3_600_000) * 3_600_000;

function iso(hoursAgo: number): string {
  return new Date(FIXTURE_EPOCH - hoursAgo * 3600 * 1000).toISOString();
}

let revisionCounter = 1000;
export function nextRevision(): string {
  revisionCounter += 7;
  return String(revisionCounter);
}

interface Seed {
  id: string;
  title: string;
  type?: string;
  status?: string;
  priority?: number;
  labels?: string[];
  assignee?: string;
  parent?: string;
  ageH?: number;
  closedH?: number;
  description?: string;
  design?: string;
  acceptance?: string;
  notes?: string;
  due?: string;
  estimate?: number;
}

function row(prefix: string, seed: Seed): FixtureIssue {
  const id = `${prefix}-${seed.id}`;
  const created = iso(seed.ageH ?? 48);
  const status = seed.status ?? "open";
  const r: FixtureIssue = {
    id,
    title: seed.title,
    issue_type: seed.type ?? "task",
    status,
    priority: seed.priority ?? 2,
    created_at: created,
    updated_at: iso((seed.ageH ?? 48) / 2),
    created_by: "kvokka",
    labels: seed.labels ?? [],
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    revision: nextRevision(),
  };
  if (seed.assignee) r.assignee = seed.assignee;
  if (seed.parent) r.parent = `${prefix}-${seed.parent}`;
  if (seed.description) r.description = seed.description;
  if (seed.design) r.design = seed.design;
  if (seed.acceptance) r.acceptance_criteria = seed.acceptance;
  if (seed.notes) r.notes = seed.notes;
  if (seed.due) r.due_at = seed.due;
  if (seed.estimate) r.estimated_minutes = seed.estimate;
  if (status === "closed") {
    r.closed_at = iso(seed.closedH ?? 24);
    r.close_reason = "done";
  }
  if (status === "in_progress" || status === "hooked") r.started_at = iso((seed.ageH ?? 48) / 3);
  return r;
}

const DESCRIPTION_MD = `The dashboard reads the backlog **only through \`bd serve\`**: no direct SQL,
no \`bd --json\`.

## Scope

- one \`bd serve\` per database, supervised by the BFF
- snapshot + SSE deltas to every open tab
- polling fallback when the journal is disabled

See [docs/bff-api.md](docs/bff-api.md) for the contract.`;

const DESIGN_MD = `\`\`\`ts
type Delta = { seq: number; upserts: BoardIssue[]; removes: string[] };
\`\`\`

A client that sees a gap in \`seq\` refetches \`/snapshot\`.`;

const ACCEPTANCE_MD = `1. Board opens with columns per status.
2. A change made with \`bd update\` shows up within the poll interval.
3. \`mise run lint && mise run typecheck && mise run test\` are green.`;

function buildSiam(): FixtureDb {
  const prefix = "sp";
  const seeds: Seed[] = [
    // Epics
    {
      id: "a1f",
      title: "Board MVP: columns, cards, filters, detail panel",
      type: "epic",
      priority: 1,
      labels: ["lane:frontend", "iteration:3"],
      assignee: "fable",
      ageH: 240,
      description: DESCRIPTION_MD,
      design: DESIGN_MD,
      acceptance: ACCEPTANCE_MD,
      notes: "Ships together with stage 2; acceptance against the real BFF.",
    },
    {
      id: "b2c",
      title: "BFF: supervisor, discovery, snapshot, SSE fan-out",
      type: "epic",
      priority: 0,
      labels: ["lane:server", "iteration:2"],
      assignee: "opus",
      ageH: 260,
      description:
        "One `bd serve` per database, supervised. Snapshot per database, deltas over SSE.",
    },
    {
      id: "c3d",
      title: "Docker image and release pipeline",
      type: "epic",
      priority: 3,
      labels: ["lane:infra", "iteration:6"],
      ageH: 300,
    },
    // Children of a1f (frontend)
    {
      id: "a1f.1",
      title: "Column layout with resizable widths",
      parent: "a1f",
      status: "closed",
      priority: 1,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 100,
      closedH: 30,
      type: "feature",
    },
    {
      id: "a1f.2",
      title: "Priority sections P0..P4, collapsible and persisted",
      parent: "a1f",
      status: "in_progress",
      priority: 1,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 90,
      type: "feature",
      estimate: 180,
    },
    {
      id: "a1f.3",
      title: "Card: id copy, type glyph, labels, assignee, blocked badge",
      parent: "a1f",
      status: "in_progress",
      priority: 2,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 80,
      type: "feature",
    },
    {
      id: "a1f.4",
      title: "Detail panel read-only with markdown",
      parent: "a1f",
      status: "open",
      priority: 2,
      labels: ["lane:frontend"],
      ageH: 70,
      type: "feature",
    },
    {
      id: "a1f.5",
      title: "Quick filters in URL query params",
      parent: "a1f",
      status: "review",
      priority: 2,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 60,
      type: "task",
    },
    {
      id: "a1f.6",
      title: "Live indicator and version warning banner",
      parent: "a1f",
      status: "open",
      priority: 3,
      labels: ["lane:frontend"],
      ageH: 50,
      type: "task",
    },
    {
      id: "a1f.7",
      title: "Russian translation review",
      parent: "a1f",
      status: "deferred",
      priority: 4,
      labels: ["lane:frontend", "i18n"],
      ageH: 40,
      type: "chore",
    },
    {
      id: "a1f.8",
      title: "Cards flicker when a delta replaces a column",
      parent: "a1f",
      status: "open",
      priority: 1,
      labels: ["lane:frontend"],
      ageH: 12,
      type: "bug",
      assignee: "fable",
    },
    // Children of b2c (server)
    {
      id: "b2c.1",
      title: "Discovery via SHOW DATABASES over MySQL protocol",
      parent: "b2c",
      status: "closed",
      priority: 0,
      labels: ["lane:server"],
      assignee: "opus",
      ageH: 200,
      closedH: 100,
      type: "feature",
    },
    {
      id: "b2c.2",
      title: "Supervisor: restart bd serve with backoff, kill proxy child",
      parent: "b2c",
      status: "in_progress",
      priority: 0,
      labels: ["lane:server"],
      assignee: "opus",
      ageH: 150,
      type: "feature",
      description:
        "`bd serve` exits 1 when dolt is down at start; the supervisor retries with backoff.",
    },
    {
      id: "b2c.3",
      title: "Snapshot builder with closed window",
      parent: "b2c",
      status: "closed",
      priority: 1,
      labels: ["lane:server"],
      assignee: "opus",
      ageH: 140,
      closedH: 50,
      type: "feature",
    },
    {
      id: "b2c.4",
      title: "SSE fan-out with seq and heartbeat",
      parent: "b2c",
      status: "hooked",
      priority: 1,
      labels: ["lane:server"],
      assignee: "opus",
      ageH: 120,
      type: "feature",
    },
    {
      id: "b2c.5",
      title: "Polling fallback when events journal is disabled",
      parent: "b2c",
      status: "blocked",
      priority: 1,
      labels: ["lane:server"],
      ageH: 110,
      type: "feature",
    },
    {
      id: "b2c.6",
      title: "bddb doctor command",
      parent: "b2c",
      status: "open",
      priority: 2,
      labels: ["lane:server", "cli"],
      ageH: 100,
      type: "task",
    },
    {
      id: "b2c.7",
      title: "Decide: proxy 503 as bddb_not_ready or pass through",
      parent: "b2c",
      status: "open",
      priority: 2,
      labels: ["lane:server"],
      ageH: 30,
      type: "decision",
    },
    {
      id: "b2c.8",
      title: "bd serve leaks db-proxy-child after SIGTERM",
      parent: "b2c",
      status: "open",
      priority: 0,
      labels: ["lane:server", "upstream"],
      ageH: 8,
      type: "bug",
    },
    // Children of c3d (infra)
    {
      id: "c3d.1",
      title: "Multi-stage Dockerfile with checksum-verified bd",
      parent: "c3d",
      status: "open",
      priority: 3,
      labels: ["lane:infra"],
      ageH: 90,
      type: "task",
    },
    {
      id: "c3d.2",
      title: "release-please workflow",
      parent: "c3d",
      status: "open",
      priority: 4,
      labels: ["lane:infra"],
      ageH: 85,
      type: "chore",
    },
    {
      id: "c3d.3",
      title: "Spike: distroless runtime with bun and git",
      parent: "c3d",
      status: "deferred",
      priority: 4,
      labels: ["lane:infra"],
      ageH: 80,
      type: "spike",
    },
    // Three-level hierarchy: epic g1a → sub-epics g1a.1 / g1a.2 → tasks, plus one direct task
    {
      id: "g1a",
      title: "Editing: writes, drag-and-drop, dialogs",
      type: "epic",
      priority: 1,
      labels: ["lane:frontend", "iteration:5"],
      assignee: "fable",
      ageH: 180,
      description: "Stage 5: every write the board needs, with guards and dialogs.",
    },
    {
      id: "g1a.1",
      title: "Drag and drop: status, priority, parent",
      type: "epic",
      parent: "g1a",
      priority: 1,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 170,
    },
    {
      id: "g1a.1.1",
      title: "Drop targets on priority sections",
      parent: "g1a.1",
      status: "closed",
      priority: 1,
      labels: ["lane:frontend"],
      ageH: 160,
      closedH: 20,
      type: "feature",
    },
    {
      id: "g1a.1.2",
      title: "Guarded PATCH after a detail read",
      parent: "g1a.1",
      status: "in_progress",
      priority: 1,
      labels: ["lane:frontend"],
      assignee: "fable",
      ageH: 150,
      type: "feature",
    },
    {
      id: "g1a.1.3",
      title: "Drop into the done column opens the close dialog",
      parent: "g1a.1",
      status: "open",
      priority: 2,
      labels: ["lane:frontend"],
      ageH: 140,
      type: "feature",
    },
    {
      id: "g1a.2",
      title: "Dialogs: close reason, force, conflict",
      type: "epic",
      parent: "g1a",
      priority: 2,
      labels: ["lane:frontend"],
      ageH: 130,
    },
    {
      id: "g1a.2.1",
      title: "Close dialog with optional reason",
      parent: "g1a.2",
      status: "open",
      priority: 2,
      labels: ["lane:frontend"],
      ageH: 120,
      type: "feature",
    },
    {
      id: "g1a.2.2",
      title: "Conflict dialog on 409 precondition_failed",
      parent: "g1a.2",
      status: "open",
      priority: 2,
      labels: ["lane:frontend"],
      ageH: 110,
      type: "feature",
    },
    {
      id: "g1a.3",
      title: "Actor setting is sent with every write",
      parent: "g1a",
      status: "closed",
      priority: 3,
      labels: ["lane:frontend"],
      ageH: 100,
      closedH: 5,
      type: "task",
    },
    // Loose issues
    {
      id: "d4e",
      title: "Live demo issue: the mock toggles this one every few seconds",
      type: "task",
      status: "open",
      priority: 2,
      labels: ["demo"],
      ageH: 5,
    },
    {
      id: "e5f",
      title: "Migrate contract tests to a beads-version matrix",
      type: "chore",
      priority: 3,
      labels: ["lane:ci"],
      ageH: 400,
    },
    {
      id: "f6a",
      title: "Keyboard navigation between cards",
      type: "feature",
      priority: 3,
      labels: ["lane:frontend", "a11y"],
      ageH: 20,
    },
    {
      id: "a7b",
      title: "Renovate config for bun, beads, dolt",
      type: "chore",
      status: "closed",
      priority: 4,
      labels: ["lane:infra"],
      ageH: 500,
      closedH: 10,
    },
    {
      id: "b8c",
      title: "README quick start",
      type: "chore",
      status: "closed",
      priority: 3,
      labels: ["docs"],
      ageH: 480,
      closedH: 150,
    },
    {
      id: "c9d",
      title: "Old closed issue outside the window",
      type: "task",
      status: "closed",
      priority: 2,
      labels: ["docs"],
      ageH: 900,
      closedH: 600,
    },
    {
      id: "d0e",
      title: "Another old closed issue",
      type: "bug",
      status: "closed",
      priority: 1,
      ageH: 950,
      closedH: 700,
    },
    {
      id: "e1f",
      title: "Pinned: coding conventions for agents",
      type: "decision",
      status: "pinned",
      priority: 2,
      labels: ["process"],
      ageH: 700,
      description: "Conventional commits, biome, no ESLint.",
    },
    {
      id: "f2a",
      title: "Story: an operator sees a CLI change within the poll interval",
      type: "story",
      priority: 2,
      labels: ["lane:server"],
      ageH: 60,
    },
    {
      id: "a3b",
      title: "Milestone: stage 3 accepted against the real BFF",
      type: "milestone",
      priority: 1,
      labels: ["iteration:3"],
      ageH: 15,
      due: "2026-09-20T00:00:00Z",
    },
    {
      id: "b4c",
      title: "Research: virtualised columns above 1000 cards",
      type: "research",
      priority: 4,
      labels: ["lane:frontend", "perf"],
      ageH: 25,
    },
    {
      id: "c5d",
      title: "Flaky contract test on slow dolt start",
      type: "bug",
      priority: 2,
      labels: ["lane:ci", "flaky"],
      ageH: 33,
      assignee: "opus",
    },
    {
      id: "d6e",
      title:
        "Long title to exercise ellipsis: the quick brown fox jumps over the lazy dog while the dashboard keeps every column readable",
      type: "task",
      priority: 3,
      labels: ["lane:frontend", "lane:server", "iteration:3", "repo:beads-dashboard", "acceptance"],
      ageH: 44,
    },
    {
      id: "e7f",
      title: "Assignee filter should match exact names",
      type: "bug",
      priority: 3,
      labels: ["lane:frontend"],
      ageH: 46,
      assignee: "kvokka",
    },
    {
      id: "f8a",
      title: "Document BDDB_BASE_PATH behind a reverse proxy",
      type: "chore",
      priority: 4,
      labels: ["docs"],
      ageH: 47,
    },
    {
      id: "a9b",
      title: "Heartbeat frame every 20 s",
      type: "task",
      status: "closed",
      priority: 2,
      labels: ["lane:server"],
      ageH: 200,
      closedH: 3,
    },
    {
      id: "b0c",
      title: "Theme toggle persists across reloads",
      type: "task",
      status: "closed",
      priority: 3,
      labels: ["lane:frontend"],
      ageH: 210,
      closedH: 40,
    },
    {
      id: "c1d",
      title: "Stats card in the header (deferred)",
      type: "feature",
      status: "deferred",
      priority: 3,
      labels: ["lane:frontend"],
      ageH: 220,
    },
  ];
  const issues = new Map<string, FixtureIssue>();
  for (const seed of seeds) {
    const r = row(prefix, seed);
    issues.set(r.id, r);
  }

  const dependencies: FixtureDependency[] = [];
  const dep = (issue: string, dependsOn: string, type = "blocks") =>
    dependencies.push({
      issue_id: `${prefix}-${issue}`,
      depends_on_id: `${prefix}-${dependsOn}`,
      type,
      created_at: iso(40),
    });
  for (const r of issues.values()) {
    if (r.parent)
      dependencies.push({
        issue_id: r.id,
        depends_on_id: r.parent,
        type: "parent-child",
        created_at: r.created_at,
      });
  }
  dep("b2c.5", "b2c.4");
  dep("b2c.5", "b2c.2");
  dep("a1f.4", "a1f.3");
  dep("g1a.1.2", "g1a.1.1");
  dep("g1a.1.3", "g1a.1.2");
  dep("g1a.2", "g1a.1");
  dep("a3b", "a1f", "tracks");
  dep("c5d", "b2c.2", "related");
  recount(issues, dependencies);

  const comments = new Map<string, Comment[]>();
  comments.set(`${prefix}-a1f`, [
    {
      id: "cm-1",
      issue_id: `${prefix}-a1f`,
      author: "kvokka",
      text: "Acceptance is against the real BFF, not the mock.",
      created_at: iso(30),
    },
    {
      id: "cm-2",
      issue_id: `${prefix}-a1f`,
      author: "fable",
      text: "Column widths persist per status name; sections per `status:priority`.",
      created_at: iso(20),
    },
  ]);
  comments.set(`${prefix}-b2c.5`, [
    {
      id: "cm-3",
      issue_id: `${prefix}-b2c.5`,
      author: "opus",
      text: "Waiting on the fan-out before the poller can share the delta path.",
      created_at: iso(10),
    },
  ]);
  for (const [id, list] of comments) {
    const r = issues.get(id);
    if (r) r.comment_count = list.length;
  }

  return {
    name: "siam_platform",
    prefix,
    statuses: [
      ...BUILTIN_STATUSES.slice(0, 1),
      { name: "review", category: "active", builtin: false },
      ...BUILTIN_STATUSES.slice(1),
    ],
    types: [...BUILTIN_TYPES, "research"],
    issues,
    dependencies,
    comments,
    liveId: `${prefix}-d4e`,
  };
}

function buildSandbox(): FixtureDb {
  const prefix = "sb";
  const seeds: Seed[] = [
    {
      id: "x1",
      title: "Try the dashboard on a second database",
      type: "task",
      priority: 2,
      ageH: 10,
    },
    { id: "x2", title: "Sandbox epic", type: "epic", priority: 2, ageH: 30 },
    {
      id: "x2.1",
      title: "First child",
      parent: "x2",
      priority: 2,
      ageH: 20,
      status: "in_progress",
      assignee: "alice",
    },
    {
      id: "x2.2",
      title: "Second child, done",
      parent: "x2",
      priority: 3,
      ageH: 19,
      status: "closed",
      closedH: 2,
    },
    {
      id: "x3",
      title: "A P0 bug in the sandbox",
      type: "bug",
      priority: 0,
      ageH: 2,
      labels: ["urgent"],
    },
    { id: "x4", title: "Backlog idea", type: "feature", priority: 4, ageH: 60 },
  ];
  const issues = new Map<string, FixtureIssue>();
  for (const seed of seeds) {
    const r = row(prefix, seed);
    issues.set(r.id, r);
  }
  const dependencies: FixtureDependency[] = [];
  for (const r of issues.values()) {
    if (r.parent)
      dependencies.push({
        issue_id: r.id,
        depends_on_id: r.parent,
        type: "parent-child",
        created_at: r.created_at,
      });
  }
  recount(issues, dependencies);
  return {
    name: "sandbox",
    prefix,
    statuses: BUILTIN_STATUSES,
    types: BUILTIN_TYPES,
    issues,
    dependencies,
    comments: new Map(),
    liveId: null,
  };
}

export function recount(issues: Map<string, FixtureIssue>, deps: FixtureDependency[]): void {
  for (const r of issues.values()) {
    r.dependency_count = 0;
    r.dependent_count = 0;
  }
  for (const d of deps) {
    const a = issues.get(d.issue_id);
    const b = issues.get(d.depends_on_id);
    if (a) a.dependency_count++;
    if (b) b.dependent_count++;
  }
}

export function buildFixture(): FixtureDb[] {
  return [buildSiam(), buildSandbox()];
}

const BLOCKING = new Set(["blocks", "conditional-blocks", "waits-for", "parent-child"]);
const DONE_OR_FROZEN = new Set(["closed", "deferred", "pinned"]);

/** Ready = open-category issue with no unresolved blocking edge (mirrors `bd ready` roughly). */
export function computeReady(db: FixtureDb): string[] {
  const out: string[] = [];
  for (const r of db.issues.values()) {
    const status = r.status ?? "open";
    if (DONE_OR_FROZEN.has(status) || status === "blocked") continue;
    const blocked = db.dependencies.some((d) => {
      if (d.issue_id !== r.id || !BLOCKING.has(d.type)) return false;
      if (d.type === "parent-child") {
        const parent = db.issues.get(d.depends_on_id);
        return parent ? (parent.status ?? "open") === "blocked" : false;
      }
      const target = db.issues.get(d.depends_on_id);
      return target ? (target.status ?? "open") !== "closed" : false;
    });
    if (!blocked) out.push(r.id);
  }
  return out;
}

/**
 * Direct-children counters per parent over the rows the snapshot would carry (same semantics
 * as the server: `child_count` = children in scope, `child_closed_count` = those in a done
 * status). `inScope` is the mock BFF's scope test.
 */
export function childCounts(
  db: FixtureDb,
  inScope: (r: FixtureIssue) => boolean,
): Map<string, { total: number; closed: number }> {
  const done = new Set(db.statuses.filter((s) => s.category === "done").map((s) => s.name));
  const out = new Map<string, { total: number; closed: number }>();
  for (const r of db.issues.values()) {
    if (!r.parent || !inScope(r)) continue;
    const entry = out.get(r.parent) ?? { total: 0, closed: 0 };
    entry.total++;
    if (done.has(r.status ?? "open")) entry.closed++;
    out.set(r.parent, entry);
  }
  return out;
}

export interface TreeItem {
  id: string;
  depth: number;
  parent_id: string;
  edge_from_parent?: string;
}

/**
 * `GET dependencies/tree` over the fixture edges: `down` follows edges the node depends on
 * (issue_id → depends_on_id), `up` the reverse; every type but `relates-to`; DFS pre-order,
 * each node at most once per walk; `both` = up nodes (without the root) then the down tree.
 */
export function walkTree(
  db: FixtureDb,
  rootId: string,
  direction: "down" | "up" | "both",
  maxDepth: number,
): TreeItem[] {
  const walk = (up: boolean): TreeItem[] => {
    const out: TreeItem[] = [];
    const seen = new Set<string>();
    const visit = (id: string, depth: number, parentId: string, edge?: string) => {
      if (seen.has(id) || !db.issues.has(id)) return;
      seen.add(id);
      const item: TreeItem = { id, depth, parent_id: parentId };
      if (edge) item.edge_from_parent = edge;
      out.push(item);
      if (depth >= maxDepth) return;
      const edges = db.dependencies.filter(
        (d) => d.type !== "relates-to" && (up ? d.depends_on_id === id : d.issue_id === id),
      );
      for (const d of edges) visit(up ? d.issue_id : d.depends_on_id, depth + 1, id, d.type);
    };
    visit(rootId, 0, "");
    return out;
  };
  if (direction === "down") return walk(false);
  if (direction === "up") return walk(true);
  return [...walk(true).slice(1), ...walk(false)];
}

/** Full detail document as `GET issues/{id}` would return it. */
export function toDetails(db: FixtureDb, id: string): IssueDetails | null {
  const r = db.issues.get(id);
  if (!r) return null;
  const { revision, ...rest } = r;
  const dependencies = db.dependencies
    .filter((d) => d.issue_id === id)
    .map((d) => db.issues.get(d.depends_on_id))
    .filter((x): x is FixtureIssue => Boolean(x))
    .map((x) => ({ ...stripRevision(x), dependency_type: depType(db, id, x.id) }));
  const dependents = db.dependencies
    .filter((d) => d.depends_on_id === id)
    .map((d) => db.issues.get(d.issue_id))
    .filter((x): x is FixtureIssue => Boolean(x))
    .map((x) => ({ ...stripRevision(x), dependency_type: depType(db, x.id, id) }));
  const children = [...db.issues.values()].filter((x) => x.parent === id);
  const details: IssueDetails = {
    ...rest,
    revision,
    dependencies,
    dependents,
    comments: db.comments.get(id) ?? [],
  };
  if ((r.issue_type ?? "") === "epic" || children.length) {
    details.epic_total_children = children.length;
    details.epic_closed_children = children.filter((c) => c.status === "closed").length;
    details.epic_closeable = details.epic_closed_children === details.epic_total_children;
  }
  return details;
}

function depType(db: FixtureDb, issue: string, dependsOn: string): string {
  return (
    db.dependencies.find((d) => d.issue_id === issue && d.depends_on_id === dependsOn)?.type ??
    "blocks"
  );
}

export function stripRevision(r: FixtureIssue): IssueWithCounts {
  const { revision: _revision, ...rest } = r;
  return rest;
}

const BULK_STATUSES = [
  "open",
  "open",
  "open",
  "in_progress",
  "blocked",
  "hooked",
  "deferred",
  "closed",
];
const BULK_TYPES = ["task", "bug", "feature", "chore"];
const BULK_LANES = ["lane:frontend", "lane:server", "lane:infra", "lane:ci"];

/** Append `count` generated issues (for render-performance checks: `MOCK_BULK=1000`). */
export function addBulk(db: FixtureDb, count: number): void {
  for (let i = 0; i < count; i++) {
    const status = BULK_STATUSES[i % BULK_STATUSES.length] as string;
    const r = row(db.prefix, {
      id: `bulk${i.toString(36)}`,
      title: `Generated issue ${i}: ${BULK_LANES[i % 4]} ${BULK_TYPES[i % 4]} number ${i}`,
      type: BULK_TYPES[i % BULK_TYPES.length] as string,
      status,
      priority: i % 5,
      labels: [BULK_LANES[i % 4] as string, `iteration:${i % 7}`],
      ageH: 1 + (i % 500),
      closedH: 1 + (i % 100),
    });
    if (i % 3 === 0) r.assignee = ["alice", "bob", "opus", "fable"][i % 4] as string;
    db.issues.set(r.id, r);
  }
}
