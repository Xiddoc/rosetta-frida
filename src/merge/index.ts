/**
 * Map merge core — the framework-neutral, pure-function engine behind
 * `rosetta merge`.
 *
 * Folds several partial maps for the SAME `(app, version_code)` into one
 * canonical map (see AGENTS.md "Form factor"): a sigmatcher run,
 * hand-authored entries, and runtime-discovered names each arrive as their
 * own partial map, and `merge` unions the `sources[]` provenance and the
 * per-class method/field entries.
 *
 * Library-first: the CLI verb (`cli/commands/merge.ts`) is a thin arg-parse
 * + IO wrapper over {@link mergeMaps}, which is re-exported from the package
 * root for programmatic use (parity with `convert`).
 */

export { mergeMaps, type MergeOptions, type ObfOverride } from './merge.js';
