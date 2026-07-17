/**
 * Built-artifact guard for the `@smplkit/sdk/<subsystem>` edge subpath
 * entries (the "dist verification" the edge-entry contract relies on):
 *
 * - Every edge entry's bundled import graph (the entry file plus the local
 *   chunks it pulls in — tsup code-splits the ESM output) must stay free of
 *   Node built-ins (`node:*`) and of `ws`, or the entries stop loading on
 *   edge runtimes such as Cloudflare Workers.
 * - Every entry graph must embed the `smplkit-sdk-ts/<version>` default
 *   User-Agent with the build-time version inlined — if the tsup `define`
 *   is ever dropped, the raw `__SMPLKIT_SDK_VERSION__` identifier would
 *   survive into the bundles and this guard fails.
 *
 * Like published-surface.test.ts, this inspects the generated artifacts:
 * CI builds before testing; a standalone run builds on demand.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distDir = join(repoRoot, "dist");

/** The edge subpath entries (package.json "exports" minus the root). */
const EDGE_ENTRIES = ["audit", "config", "flags", "logging", "jobs", "platform", "account"];

/** Import/require patterns that must never appear in an edge entry's graph. */
const FORBIDDEN = [
  /["']node:/, // any Node built-in, e.g. from "node:fs" / require("node:fs")
  /\bfrom\s*["']ws["']/, // ESM import of the ws package
  /\brequire\(["']ws["']\)/, // CJS require of the ws package
  /\bimport\(["']ws["']\)/, // dynamic import of the ws package
];

/**
 * Read `file` plus every local chunk it (transitively) imports, returning
 * the concatenated sources keyed by file name.
 */
function readGraph(file: string): Map<string, string> {
  const sources = new Map<string, string>();
  const queue = [file];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (sources.has(name)) continue;
    const code = readFileSync(join(distDir, name), "utf-8");
    sources.set(name, code);
    for (const match of code.matchAll(/["'](\.\/[^"']+)["']/g)) {
      const local = match[1].replace(/^\.\//, "");
      if (/\.(js|cjs)$/.test(local) && existsSync(join(distDir, local))) {
        queue.push(local);
      }
    }
  }
  return sources;
}

describe("dist edge entries (built-artifact guard)", () => {
  beforeAll(() => {
    if (!existsSync(join(distDir, "audit.js"))) {
      execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
    }
  }, 120_000);

  describe.each(EDGE_ENTRIES)("%s", (entry) => {
    it.each(["js", "cjs"])("the .%s graph is free of node:* and ws", (ext) => {
      for (const [name, code] of readGraph(`${entry}.${ext}`)) {
        for (const pattern of FORBIDDEN) {
          expect(code, `${name} (via ${entry}.${ext}) matches ${pattern}`).not.toMatch(pattern);
        }
      }
    });

    it.each(["js", "cjs"])(
      "the .%s graph embeds the default User-Agent with the version inlined",
      (ext) => {
        const graph = [...readGraph(`${entry}.${ext}`).values()].join("\n");
        expect(graph).toContain("smplkit-sdk-ts/");
        // The define must have replaced the injection point entirely.
        expect(graph).not.toContain("__SMPLKIT_SDK_VERSION__");
      },
    );
  });
});
