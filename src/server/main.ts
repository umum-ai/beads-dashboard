/**
 * bddb BFF entry point. Stage 0 skeleton: serves /healthz only.
 * The full server (discovery, bd serve supervisor, snapshot, SSE fan-out) arrives in stage 2.
 */

export interface ServeOptions {
  host?: string;
  port?: number;
}

export function startServer(options: ServeOptions = {}) {
  const host = options.host ?? process.env.BDDB_HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.BDDB_PORT ?? 7331);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return new Response("bddb skeleton", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`bddb: listening on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
