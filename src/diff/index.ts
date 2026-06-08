/**
 * Map diff core — the framework-neutral, pure-function engine behind
 * `rosetta diff`.
 *
 * Reports what *rotated* between two `schema_version: 2` maps: classes,
 * methods, and fields that were added, removed, or whose obfuscated name
 * (or method signature) changed. This is the canonical "what changed in
 * this release" report — the obfuscation-rotation pain this whole project
 * exists to absorb (see AGENTS.md "Why this project exists").
 *
 * The diff is computed over REAL names (the map keys) — the stable identity
 * across versions — and reports how each real name's *obfuscated* spelling
 * moved.
 *
 * This module is library-first: the CLI verb (`cli/commands/diff.ts`) is a
 * thin arg-parse + IO wrapper over {@link diffMaps} / {@link renderHumanDiff},
 * and these are re-exported from the package root so they are usable
 * programmatically (parity with `convert`).
 */

export {
    diffMaps,
    renderHumanDiff,
    type MapDiff,
    type ClassDelta,
    type ObfChange,
    type SignatureChange,
} from './diff.js';
