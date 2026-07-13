import { createRequire } from "node:module";

/**
 * Resolves the absolute filesystem path to Gatoway core's built entry point
 * (`@gatoway/core`'s `dist/index.js`) via Node's own module resolution against the
 * workspace dependency (design.md D2), rather than hand-constructing a relative or
 * `file://` path string.
 *
 * This deliberately avoids the exact class of bug QA-005 uncovered in
 * `gatoway-core-foundation`: a manually built `file://` path string there silently
 * failed to match whenever the invoking path needed URL-encoding (e.g. contained
 * spaces, as this project's own path does). Resolving through `require.resolve`
 * against the package name sidesteps hand-built path/URL comparisons entirely — Node's
 * module resolution handles locating the file on disk, including any special
 * characters in the path.
 *
 * Throws if `@gatoway/core` cannot be resolved at all, or if it has no built
 * `dist/index.js` yet (e.g. a fresh checkout that hasn't been built) — callers are
 * expected to catch this and report it visibly (tasks.md 2.5) rather than proceeding
 * as if nothing were wrong.
 */
export function locateCoreEntryPoint(resolveFromUrl: string = import.meta.url): string {
  const require = createRequire(resolveFromUrl);
  return require.resolve("@gatoway/core/dist/index.js");
}
