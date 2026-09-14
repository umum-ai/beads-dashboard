import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  directorySource,
  embeddedSource,
  filesAssets,
  injectBaseHref,
  relativizeAssetUrls,
} from "../../../src/server/static.ts";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>bddb</title>
<link rel="stylesheet" href="/chunk-abc123.css"><script type="module" src="../../index-def456.js"></script>
<a href="https://example.com/chunk-abc123.css">x</a></head><body></body></html>`;

describe("static: index.html rewriting", () => {
  test('injectBaseHref: root → <base href="/">, prefix → <base href="/prefix/">, idempotent', () => {
    expect(injectBaseHref("<html><head><title>x</title></head></html>", "")).toContain(
      '<head><base href="/"><title>',
    );
    expect(injectBaseHref("<html><head></head></html>", "/beads")).toContain(
      '<head><base href="/beads/">',
    );
    const once = injectBaseHref("<html><head></head></html>", "/a");
    expect(injectBaseHref(once, "/b")).toBe(once);
  });

  test("relativizeAssetUrls: known basenames become ./name whatever the directory part", () => {
    const out = relativizeAssetUrls(HTML, ["chunk-abc123.css", "index-def456.js"]);
    expect(out).toContain('href="./chunk-abc123.css"');
    expect(out).toContain('src="./index-def456.js"');
    // Absolute URLs and unknown names are untouched.
    expect(out).toContain('href="https://example.com/chunk-abc123.css"');
    expect(relativizeAssetUrls('<a href="/p/kb/board">', ["x.js"])).toBe('<a href="/p/kb/board">');
  });
});

describe("static: files mode", () => {
  test("directorySource serves index under /p/*, hashed assets immutable, no traversal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bddb-static-"));
    try {
      await writeFile(path.join(dir, "index.html"), HTML);
      await writeFile(path.join(dir, "chunk-abc123.css"), "body{}");
      await writeFile(path.join(dir, "index-def456.js"), "export {}");
      const assets = await filesAssets(directorySource(dir), "/beads");
      expect(assets.mode).toBe("files");

      const index = await assets.handle("/p/kb/board");
      expect(index?.status).toBe(200);
      const body = await index?.text();
      expect(body).toContain('<base href="/beads/">');
      expect(body).toContain('href="./chunk-abc123.css"');
      expect(body).toContain('src="./index-def456.js"');

      const css = await assets.handle("/chunk-abc123.css");
      expect(css?.status).toBe(200);
      expect(css?.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(css?.headers.get("cache-control")).toContain("immutable");

      expect(await assets.handle("/missing.js")).toBeNull();
      expect(await assets.handle("/../etc/passwd")).toBeNull();
      expect(await assets.handle("/")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("embeddedSource: null without a build manifest, files map otherwise", async () => {
    // Running from source: the imported HTML bundle has no `files`.
    expect(embeddedSource({ index: "x.html" } as Bun.HTMLBundle)).toBeNull();
    const dir = await mkdtemp(path.join(os.tmpdir(), "bddb-embedded-"));
    try {
      await writeFile(path.join(dir, "index.html"), HTML);
      await writeFile(path.join(dir, "chunk-abc123.css"), "body{}");
      const source = embeddedSource({
        index: path.join(dir, "index.html"),
        files: [
          { path: path.join(dir, "index.html"), loader: "html", isEntry: true },
          { path: path.join(dir, "chunk-abc123.css"), loader: "css", isEntry: false },
        ],
      } as Bun.HTMLBundle);
      expect(source).not.toBeNull();
      expect(await source?.names()).toEqual(["chunk-abc123.css"]);
      expect(await source?.resolve("chunk-abc123.css")).toBe(path.join(dir, "chunk-abc123.css"));
      expect(await source?.resolve("nope.css")).toBeNull();
      const assets = await filesAssets(source as NonNullable<typeof source>, "");
      const body = await (await assets.handle("/p/kb/board"))?.text();
      expect(body).toContain('<base href="/">');
      expect(body).toContain('href="./chunk-abc123.css"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
