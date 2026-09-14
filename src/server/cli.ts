#!/usr/bin/env bun
/**
 * bddb command-line entry point.
 *
 *   bddb serve   start the dashboard (BFF + SPA)
 *   bddb doctor  check dolt, bd and bd serve reachability (stage 2)
 */
import { startServer } from "./main.ts";

const USAGE = `bddb - kanban dashboard for beads (bd serve HTTP API)

Usage:
  bddb serve    Start the dashboard server (BDDB_HOST, BDDB_PORT, ...)
  bddb doctor   Diagnose the environment: dolt, bd, bd serve, events journal
  bddb help     Show this message
`;

export function main(argv: readonly string[]): number {
  const [command] = argv;
  switch (command) {
    case "serve":
      startServer();
      return 0;
    case "doctor":
      console.log("bddb doctor: not implemented yet (stage 2)");
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
  const code = main(process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}
