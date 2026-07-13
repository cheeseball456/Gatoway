#!/usr/bin/env node
/**
 * Packages the TypeScript build's output (`dist/`) into the exact location the Stream
 * Deck application actually loads: `com.gatoway.streamdeck.sdPlugin/bin/`, matching
 * `manifest.json`'s `CodePath: "bin/plugin.js"` (QA-006).
 *
 * `tsc` alone only ever emits to `dist/`, which the Stream Deck application never
 * looks at directly - `CodePath` is resolved relative to the `.sdPlugin` bundle folder.
 * This script runs as a `postbuild`-style step after `tsc` and copies the compiled
 * output tree as-is into `.sdPlugin/bin/`, so relative imports between compiled files
 * keep working unchanged. Node module resolution for bare specifiers (`@elgato/streamdeck`,
 * `@gatoway/core`) still finds the right `node_modules` by walking up from
 * `com.gatoway.streamdeck.sdPlugin/bin/` through `stream-deck-plugin/` (and, since this
 * project uses npm workspaces, the repo root) - no bundler is required for this to
 * resolve correctly.
 */
import { existsSync, cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const distDir = path.join(packageRoot, "dist");
const pluginBinDir = path.join(
  packageRoot,
  "com.gatoway.streamdeck.sdPlugin",
  "bin",
);

if (!existsSync(distDir)) {
  throw new Error(
    `packagePlugin: expected build output at ${distDir}, but it does not exist. ` +
      "Run `tsc -p tsconfig.json` before this script (see the `build` script in package.json).",
  );
}

rmSync(pluginBinDir, { recursive: true, force: true });
cpSync(distDir, pluginBinDir, { recursive: true });

const entryPoint = path.join(pluginBinDir, "plugin.js");
if (!existsSync(entryPoint)) {
  throw new Error(
    `packagePlugin: copied ${distDir} to ${pluginBinDir}, but the manifest's CodePath ` +
      `entry point (${entryPoint}) is still missing. Check that src/plugin.ts compiles to dist/plugin.js.`,
  );
}

console.log(`packagePlugin: copied ${distDir} -> ${pluginBinDir}`);
