# Security

## Reporting a vulnerability

Please report security issues privately through the "Report a vulnerability" form on this
repository (GitHub Security tab) rather than in a public issue. You should get an
acknowledgement within a week.

## Scope and design notes

- bddb has **no authentication or authorization**. It is meant to run on a trusted network or
  behind a reverse proxy that handles access control. Exposing it publicly exposes your
  entire beads backlog, including write access.
- bddb connects to your Dolt SQL server with the credentials you provide (`BDDB_DOLT_USER`,
  `BDDB_DOLT_PASSWORD`). A password-less Dolt listening on `0.0.0.0` is reachable by anyone
  on that network.
- `bd serve` processes started by bddb bind to loopback only.
