/**
 * The configuration reference must match the code one to one: every `BDDB_*` variable that
 * `src/server/config.ts` reads has a row in docs/configuration.md (and in the README table),
 * and the docs name no variable the code does not read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLAG_ENV } from "../../../src/server/config.ts";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

const codeVars = new Set(Object.values(FLAG_ENV));

/** `BDDB_*` names in the first cell of every table row (`| \`BDDB_X\` | …`). */
function documentedInTable(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^\|\s*((?:`BDDB_[A-Z_]+`\s*(?:\/\s*)?)+)\|/gm)) {
    for (const v of m[1]?.matchAll(/BDDB_[A-Z_]+/g) ?? []) out.add(v[0]);
  }
  return out;
}

describe("docs/configuration.md ↔ config.ts", () => {
  const doc = read("docs/configuration.md");
  const documented = documentedInTable(doc);

  test("every variable the code reads is documented", () => {
    expect([...codeVars].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  test("every documented variable is read by the code", () => {
    expect([...documented].filter((v) => !codeVars.has(v)).sort()).toEqual([]);
  });

  test("every flag is documented with its variable", () => {
    for (const [flag, env] of Object.entries(FLAG_ENV)) {
      expect(doc, `--${flag} for ${env}`).toContain(`\`--${flag}\``);
    }
  });
});

describe("README configuration table ↔ config.ts", () => {
  const readme = read("README.md");
  const documented = documentedInTable(readme);

  test("lists every variable", () => {
    expect([...codeVars].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  test("names no unknown variable", () => {
    expect([...documented].filter((v) => !codeVars.has(v)).sort()).toEqual([]);
  });
});

describe("no stray BDDB_* names in the docs", () => {
  test("every BDDB_* mentioned anywhere in docs/, README or the compose example exists", () => {
    const files = [
      "README.md",
      "docker-compose.example.yml",
      "docs/configuration.md",
      "docs/deployment.md",
      "docs/host-setup.md",
      "docs/topology.md",
      "docs/bff-api.md",
      "docs/ui.md",
      "docs/compatibility.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "AGENTS.md",
    ];
    const unknown: string[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(/(?<![_A-Z])BDDB_[A-Z][A-Z_]*/g)) {
        // BDDB_URL and BDDB_VERSION are not configuration: the e2e target and the build stamp.
        if (["BDDB_URL", "BDDB_VERSION"].includes(m[0])) continue;
        if (!codeVars.has(m[0])) unknown.push(`${file}: ${m[0]}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});
