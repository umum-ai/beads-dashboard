# Contributing

Thanks for your interest in bddb. The project is in early development and maintained mostly by
agents; small, focused pull requests are the easiest to review.

## Setup

```sh
mise install
bun install
```

## Before opening a pull request

```sh
mise run lint
mise run typecheck
mise run test
```

- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `chore:`, `ci:`). Release notes are generated from them.
- Formatting is enforced by biome (`mise run lint:fix`).
- Changes to the `bd serve` contract go through `spec/openapi.v0.yaml` and regenerated types;
  do not hand-edit generated files.
- Add or update tests with behavior changes. Contract tests run against a real `bd serve`.

## Reporting issues

Open a GitHub issue with the beads version (`bd version`), the dashboard version, and the
steps to reproduce. For security issues see [SECURITY.md](SECURITY.md).
