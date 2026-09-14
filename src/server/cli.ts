#!/usr/bin/env bun
/**
 * bddb command-line entry point.
 *
 *   bddb serve [flags]   start the dashboard (BFF + SPA)
 *   bddb doctor [flags]  check dolt, bd, bd serve and the events journal
 *   bddb version         print versions
 *   bddb help            this text
 *
 * Flags mirror the BDDB_* environment variables one to one (src/server/config.ts).
 */
import { ConfigError, FLAGS_HELP, loadConfig } from "./config.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { reportStartupError, startServer } from "./main.ts";
import { BDDB_VERSION, BUILT_FOR_BEADS } from "./version.ts";

const USAGE = `bddb ${BDDB_VERSION} — kanban dashboard for beads (bd serve HTTP API)

Usage:
  bddb serve [flags]    Start the dashboard server
  bddb doctor [flags]   Diagnose the environment: dolt, bd, bd serve, events journal
  bddb version          Print bddb and target beads versions
  bddb help             Show this message

${FLAGS_HELP}

Docs: docs/configuration.md, docs/host-setup.md`;

/** Parse-only commands return an exit code; `serve` returns `null` and keeps running. */
export async function main(argv: readonly string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      try {
        await startServer({ argv: rest });
        return null;
      } catch (err) {
        return reportStartupError(err);
      }
    }
    case "doctor": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      try {
        const config = loadConfig({ argv: rest });
        const report = await runDoctor({ config });
        console.log(formatReport(report));
        return report.exitCode;
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(`bddb: ${err.message}`);
          return 2;
        }
        throw err;
      }
    }
    case "version":
    case "--version":
    case "-v":
      console.log(`bddb ${BDDB_VERSION} (built for beads ${BUILT_FOR_BEADS})`);
      return 0;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`bddb: unknown command "${command}"\n`);
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
