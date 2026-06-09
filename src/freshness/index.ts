/**
 * Map-freshness core — the framework-neutral, pure-function engine behind
 * `rosetta freshness`, the read-only consumer twin of the maps-side
 * `check_map_freshness.py` CI check (maps#34).
 *
 * Library-first: the CLI verb (`cli/commands/freshness.ts`) is a thin
 * arg-parse + IO wrapper over these functions, and they are re-exported from
 * the package root so the same freshness computation is usable
 * programmatically (parity with `diff` / `merge` / `verify`).
 */

export {
    analyse,
    ruleFqns,
    parseSignatures,
    mapClassKeys,
    parseMapClassKeys,
    renderReport,
    FreshnessInputError,
    type FreshnessFinding,
    type FreshnessReport,
    type MapClassKeys,
} from './freshness.js';
