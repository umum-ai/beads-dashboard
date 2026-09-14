# bddb documentation

Start with the [README](../README.md): requirements (server-mode workspaces, one shared Dolt,
events journal on the host), install on the host or with Docker, the most used variables.

| Document | Read it when |
|---|---|
| [topology.md](topology.md) | you want to know what runs where: browser → bddb → `bd serve` × N → your Dolt; synthesized workspaces, process lifecycle, live updates |
| [host-setup.md](host-setup.md) | preparing the machine that runs Dolt and your agents: reachable `dolt sql-server`, server-mode workspaces (and how to convert an embedded one), the events journal, versions |
| [configuration.md](configuration.md) | every `BDDB_*` variable and its flag, discovery, base path, ports and processes, the startup failure messages and exit codes |
| [deployment.md](deployment.md) | running the image or the binary for real: Docker networking, compose, health checks, reverse proxy with a prefix, upgrades, local builds |
| [compatibility.md](compatibility.md) | which bddb goes with which beads, where the version is pinned, how a beads bump happens |
| [bff-api.md](bff-api.md) | the HTTP/SSE contract between the bddb server and the SPA (`/api/meta`, snapshot, event frames, proxies, `DatabaseInfo` states and `lastError`) |
| [api-client.md](api-client.md) | the typed client for `bd serve` (`src/api-client`), Problem handling, capability gating, contract tests |
| [ui.md](ui.md) | the SPA: layout, state model, board rules, hierarchy, editing, keyboard shortcuts and accessibility, empty / error / connection states, i18n, theming, mock and e2e |

Contributing, security and the agents' operating manual live at the repository root:
[CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), [AGENTS.md](../AGENTS.md).

`screenshots/` holds the board screenshots — `board-light.png` (README) and `board-dark.png`
(the same board in the dark theme); `mise run screenshots` regenerates them from the mock.
