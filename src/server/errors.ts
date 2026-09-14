/**
 * Startup failure with hints, printed by the CLI like `bddb doctor` prints them; exit 2.
 * Lives in its own module so `workspace.ts` (imported by `supervisor.ts`, which `preflight.ts`
 * imports) can throw it without an import cycle.
 */
export class StartupError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = "StartupError";
    this.hints = hints;
  }
}
