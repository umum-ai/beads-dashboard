/**
 * `bddb serve` runtime: load configuration, create the app, stop everything on SIGINT/SIGTERM.
 * `bun --hot src/server/main.ts` keeps the previous app on `globalThis` and stops it before
 * starting the new one, so hot reloads do not leak `bd serve` processes.
 */
import { type App, createApp } from "./app.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { DiscoveryError } from "./discovery.ts";
import { createLogger, type Logger } from "./log.ts";
import { StartupError } from "./preflight.ts";

declare global {
  var __bddbApp: App | undefined;
}

export interface StartOptions {
  config?: Config;
  argv?: readonly string[];
  log?: Logger;
}

/** Create the app and wire process signals. Rejects with `ConfigError` / `DiscoveryError`. */
export async function startServer(options: StartOptions = {}): Promise<App> {
  const config = options.config ?? loadConfig({ argv: options.argv ?? [] });
  const log = options.log ?? createLogger({ level: config.logLevel, format: config.logFormat });
  const app = await createApp({ config, log });
  globalThis.__bddbApp = app;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // Under `bun --hot` the previous module instance keeps its handlers; only the live app acts.
    if (globalThis.__bddbApp !== app || shuttingDown) return;
    shuttingDown = true;
    log.info("signal received", { signal });
    const timer = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, 15_000);
    app
      .stop()
      .catch((err: unknown) => log.error("shutdown failed", { error: err }))
      .finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  return app;
}

/**
 * Print a startup failure the way the CLI does and return the exit code: 2 for anything the
 * operator can fix (configuration, dolt/discovery, bd binary — with hints like `bddb doctor`),
 * 1 for an unexpected error (with its stack).
 */
export function reportStartupError(
  err: unknown,
  print: (line: string) => void = console.error,
): number {
  if (err instanceof ConfigError) {
    print(`bddb: ${err.message}`);
    print("  → see `bddb help` and docs/configuration.md");
    return 2;
  }
  if (err instanceof DiscoveryError || err instanceof StartupError) {
    print(`bddb: cannot start: ${err.message}`);
    for (const hint of err.hints) print(`  → ${hint}`);
    return 2;
  }
  if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
    print(`bddb: cannot start: ${err.message}`);
    print("  → another process listens on BDDB_HOST:BDDB_PORT; pick another --port or stop it");
    return 2;
  }
  print(`bddb: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return 1;
}

if (import.meta.main) {
  if (globalThis.__bddbApp) {
    await globalThis.__bddbApp.stop();
    globalThis.__bddbApp = undefined;
  }
  try {
    await startServer({ argv: process.argv.slice(2) });
  } catch (err) {
    process.exit(reportStartupError(err));
  }
}
