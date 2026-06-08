/**
 * Version-label → numeric tuple parsing and the ONE lexicographic
 * comparator shared across the fuzzy-matching machinery.
 *
 * Both the config-layer range refinements (`config.ts`) and the runtime
 * pick (`version-match.ts`) parse labels and compare bounds the same way;
 * keeping a SINGLE `compareTuple` here removes the parity-drift hazard of
 * two hand-rolled 3-component comparators getting out of step (the f13 /
 * xposed#13 family of bugs the module warns about). Kotlin twin:
 * `VersionMatch.numeric` / `versionDistance` / `compareDistance`.
 */

/** `[major, minor, patch]`; missing components default to 0. */
export type VersionTuple = readonly [number, number, number];

/**
 * Lexicographic compare of two version tuples (major dominates, then
 * minor, then patch). The single source of truth for "is tuple a < b":
 * used for range-bound checks AND the nearest-pick tie-break so the two
 * paths can never disagree.
 */
export function compareTuple(a: VersionTuple, b: VersionTuple): number {
    for (let i = 0; i < 3; i += 1) {
        const c = (a[i] as number) - (b[i] as number);
        if (c !== 0) return c;
    }
    return 0;
}

/**
 * Parse a version string into a `[major, minor, patch]` tuple.
 *
 * Pre-release and build suffixes (`-alpha`, `+build42`) are stripped.
 * Non-numeric components are clamped to 0 so we always get a tuple.
 */
export function parseVersion(version: string): VersionTuple {
    // `String.split` always returns at least one element, so [0] is always
    // defined — the cast keeps TypeScript happy under noUncheckedIndexedAccess.
    const stripped = version.split(/[-+]/, 1)[0] as string;
    const parts = stripped.split('.');
    return [numeric(parts[0]), numeric(parts[1]), numeric(parts[2])];
}

/**
 * Parse a single dotted version component to an integer.
 *
 * STRICT, to mirror the Kotlin twin (`VersionMatch.numeric`, which uses
 * `String.toIntOrNull() ?: 0`): a component contributes its value ONLY if
 * it is a pure non-negative 32-bit integer; anything else contributes 0.
 * That means embedded/trailing non-numerics (`"12abc"`, `"12 "`, `"1_2"`)
 * and out-of-`Int`-range values (`> 2147483647`) all collapse to 0, instead
 * of `Number.parseInt`'s lenient prefix/huge-number behaviour — otherwise
 * the two clients would parse different tuples for the same label and could
 * select different maps in the fuzzy path.
 */
export function numeric(component: string | undefined): number {
    if (component === undefined || component === '') return 0;
    if (!/^\d+$/.test(component)) return 0;
    const n = Number.parseInt(component, 10);
    return n <= 2147483647 ? n : 0;
}

/**
 * Per-component absolute distance `[|Δmajor|, |Δminor|, |Δpatch|]`.
 *
 * Returned as a 3-vector (NOT a single weighted sum) so ranking is
 * lexicographic and cannot overflow a positional bucket — the f13 /
 * xposed#13 bug where `1.0.142` (sum 142) tied `1.1.42` (sum 142).
 * Kotlin twin: `VersionMatch.versionDistance`.
 */
export function versionDistance(a: VersionTuple, b: VersionTuple): VersionTuple {
    return [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])];
}
