/**
 * Selecting a `RosettaMap` for the running app version.
 *
 * The session may be handed:
 *   - A single `RosettaMap` — use as-is. The version is validated
 *     against the detected app at the session layer.
 *   - A `RosettaMapRegistry` — a record of `RosettaMap` keyed by
 *     version *label*. Pick the entry that matches the running build.
 *
 * Selection precedence (RFC 0001 Decision 3):
 *   1. `version_code` — the authoritative, O(1) key. When the caller
 *      supplies a detected/overridden `versionCode`, we look it up in a
 *      `version_code → key` index memoised on the registry (built once in
 *      O(n), then O(1) per lookup) and return that map regardless of its
 *      label. This is exact, never fuzzy.
 *   2. version *label* — the fallback when no `versionCode` is available
 *      or no map carries the detected code. Behaves as before:
 *      - 'exact' (default) — registry must contain an entry whose key
 *        equals the version label. No match → throw.
 *      - 'fuzzy' — fall back to the closest available label by
 *        component-wise major-minor-patch distance (user opts in via
 *        `versionMatch: 'fuzzy'`).
 *
 * Fuzzy comparison parses each version into a numeric
 * `[major, minor, patch]` tuple (defaulting missing components to 0,
 * ignoring pre-release / build suffixes) and ranks candidates by
 * LEXICOGRAPHIC component distance — NOT a weighted positional sum. The
 * old `major × 10_000 + minor × 100 + patch` heuristic OVERFLOWED its
 * positional buckets once a component reached its weight (e.g. `1.0.142`
 * tied `1.1.42`, both summing to 142); the per-component distance vector
 * `[|Δmajor|, |Δminor|, |Δpatch|]` compared major-first cannot collide
 * that way (the f13 / xposed#13 parity gap). If two candidates tie on
 * distance, the lower version wins, then the raw label string — so the
 * pick is total and deterministic (mirrors the Kotlin
 * `VersionMatch.versionDistance` + `compareDistance`).
 */

import { resolveVersionMatch, type VersionMatchConfig } from '../config.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import type { VersionMatch } from '../types/session.js';

/** A single ranked fuzzy candidate, exposed when `ranked` is opted-in. */
export interface RankedCandidate {
    /** The registry key (version label) of this candidate. */
    registryKey: string;
    /** Component-wise distance `[|Δmajor|, |Δminor|, |Δpatch|]` to the target. */
    distance: readonly [number, number, number];
}

/** A picked-from-registry result, with fuzzy provenance for emit. */
export interface PickedMap {
    /** The selected map. */
    map: RosettaMap;
    /** True if the pick came from a registry (vs. a single-map input). */
    fromRegistry: boolean;
    /** True if the registry pick was fuzzy (i.e. not an exact version match). */
    fuzzy: boolean;
    /** The version key under which this map was registered (registry only). */
    registryKey?: string;
    /**
     * How the fuzzy fallback selected this map, when it did. Undefined for an
     * exact (`version_code` or label) match. `'nearest'` is the legacy
     * closest-label pick; `'code-range'` / `'label-range'` are the opt-in
     * range fallbacks.
     */
    fuzzyKind?: 'nearest' | 'code-range' | 'label-range';
    /**
     * Ranked candidates (closest first), present only when the caller opted
     * in via `ranked: true` AND the pick went through a fuzzy path. Includes
     * the winner at index 0.
     */
    ranked?: readonly RankedCandidate[];
}

/** Options controlling the pick. */
export interface PickMapOptions {
    /** The user-supplied or auto-detected version *label* to satisfy. */
    version: string;
    /**
     * The authoritative version code, when known. Takes precedence over
     * the version label: a registry entry whose `version_code` equals
     * this is selected directly. Undefined falls back to label matching.
     */
    versionCode?: number;
    /**
     * Version-matching mode. Accepts the legacy `'exact'` / `'fuzzy'` string
     * or the richer object form; both normalize to a {@link VersionMatchConfig}
     * via `resolveVersionMatch`. Defaults to `'exact'`.
     */
    versionMatch?: VersionMatch;
}

/**
 * Type guard: distinguish a single `RosettaMap` from a registry.
 *
 * A `RosettaMap` has the top-level `schema_version` discriminator; a
 * registry is a plain `Record<string, RosettaMap>` whose values have it.
 */
export function isRegistry(input: RosettaMap | RosettaMapRegistry): input is RosettaMapRegistry {
    return (input as Partial<RosettaMap>).schema_version === undefined;
}

/**
 * Per-registry `version_code → registry key` index, memoised on the
 * registry object so the authoritative selection is genuinely O(1) across
 * repeated lookups (the first lookup builds it in O(n); subsequent lookups
 * — e.g. multiple sessions over the same bundle — are constant-time). A
 * `WeakMap` keys off the registry identity so the index is GC'd with it and
 * we never mutate the caller's object.
 *
 * Collision policy: when two maps share a `version_code` (which shouldn't
 * happen in a well-formed bundle) the FIRST one in iteration order wins —
 * the `!index.has(...)` putIfAbsent guard below never overwrites an existing
 * entry. This FIRST-WINS rule is the CROSS-CLIENT CANONICAL policy: the
 * Kotlin rosetta-xposed registry loader matches it (putIfAbsent), so a
 * duplicate-laden bundle selects the same map on both clients. Do not flip
 * this to last-wins without changing the Kotlin twin in lockstep.
 */
const versionCodeIndexCache = new WeakMap<RosettaMapRegistry, Map<number, string>>();

function versionCodeIndex(registry: RosettaMapRegistry): Map<number, string> {
    let index = versionCodeIndexCache.get(registry);
    if (index === undefined) {
        index = new Map<number, string>();
        for (const key of Object.keys(registry)) {
            const candidate = registry[key];
            // putIfAbsent: first key to claim a version_code keeps it
            // (FIRST-WINS, the cross-client canonical collision policy).
            if (candidate && !index.has(candidate.version_code)) {
                index.set(candidate.version_code, key);
            }
        }
        versionCodeIndexCache.set(registry, index);
    }
    return index;
}

/**
 * Pick a `RosettaMap` for the given version.
 *
 * - For a single-map input: always returns it (the session-layer
 *   version check decides whether the pick is acceptable).
 * - For a registry input: tries exact match, then optionally fuzzy.
 *
 * @throws Error if a registry has no exact match in 'exact' mode, or
 *   if a registry is empty (fuzzy can't pick from nothing).
 */
export function pickMapForVersion(
    input: RosettaMap | RosettaMapRegistry,
    { version, versionCode, versionMatch }: PickMapOptions,
): PickedMap {
    // Normalize the legacy string / object form into the resolved policy.
    // `undefined` → `{ strategy: 'exact', ... }` (fail-hard-by-default).
    const policy = resolveVersionMatch(versionMatch);

    if (!isRegistry(input)) {
        return { map: input, fromRegistry: false, fuzzy: false };
    }

    const keys = Object.keys(input);
    if (keys.length === 0) {
        throw new Error(
            `rosetta-frida: map registry is empty — cannot pick a map for version '${version}'.`,
        );
    }

    // 1. Authoritative selection by version_code (RFC 0001 Decision 3),
    //    via the memoised version_code → key index — genuinely O(1) per
    //    lookup (the index is built once per registry object). EXACT and
    //    highest-precedence: never overridden by any fuzzy/range knob.
    if (versionCode !== undefined) {
        const key = versionCodeIndex(input).get(versionCode);
        if (key !== undefined) {
            const candidate = input[key];
            if (candidate) {
                return { map: candidate, fromRegistry: true, fuzzy: false, registryKey: key };
            }
        }
        // No map carries the detected code — fall through to label matching,
        // which surfaces a precise error (or fuzzy fallback) below.
    }

    // 2. Fallback selection by version label (exact).
    const exact = input[version];
    if (exact !== undefined) {
        return { map: exact, fromRegistry: true, fuzzy: false, registryKey: version };
    }

    // 3. Opt-in version_code RANGE fallback (highest-priority fuzzy path: a
    //    numeric code range is more authoritative than a label range). Only
    //    engaged when the caller supplied it.
    if (policy.versionCodeRange !== undefined) {
        const picked = pickByCodeRange(input, keys, policy.versionCodeRange, versionCode);
        if (picked !== null) return picked;
    }

    // 4. Opt-in version LABEL range fallback.
    if (policy.versionRange !== undefined) {
        const picked = pickByLabelRange(input, keys, version, policy.versionRange, policy);
        if (picked !== null) return picked;
    }

    // 5. Nearest-label fuzzy fallback (the legacy `versionMatch: 'fuzzy'`
    //    behaviour). Off unless `strategy: 'fuzzy'`.
    if (policy.strategy !== 'fuzzy') {
        throw new Error(
            `rosetta-frida: no map for version '${version}' in registry (available: ${keys
                .sort()
                .join(', ')}). Pass versionMatch: 'fuzzy' to fall back to the closest map.`,
        );
    }

    const ranking = rankByDistance(parseVersion(version), keys);
    // `keys.length > 0` was checked above, so the ranking is non-empty.
    const winner = ranking[0] as { key: string; distance: VersionTuple };

    // Opt-in maxDistance ceiling: reject a pick that is too far, fail loudly.
    if (
        policy.maxDistance !== null &&
        policy.maxDistance !== undefined &&
        exceedsMaxDistance(winner.distance, policy.maxDistance)
    ) {
        throw new Error(
            `rosetta-frida: closest map for version '${version}' is '${winner.key}' ` +
                `(distance [${winner.distance.join(', ')}]), which exceeds the configured ` +
                `maxDistance of ${policy.maxDistance}. No acceptable map in registry ` +
                `(available: ${keys.sort().join(', ')}).`,
        );
    }

    return finishFuzzy(input, winner.key, 'nearest', policy, ranking);
}

/**
 * Build a {@link PickedMap} for a fuzzy winner, attaching ranked candidates
 * when the caller opted in.
 */
function finishFuzzy(
    registry: RosettaMapRegistry,
    key: string,
    fuzzyKind: 'nearest' | 'code-range' | 'label-range',
    policy: VersionMatchConfig,
    ranking?: readonly { key: string; distance: VersionTuple }[],
): PickedMap {
    const result: PickedMap = {
        map: registry[key] as RosettaMap,
        fromRegistry: true,
        fuzzy: true,
        registryKey: key,
        fuzzyKind,
    };
    if (policy.ranked && ranking !== undefined) {
        result.ranked = ranking.map((r) => ({ registryKey: r.key, distance: r.distance }));
    }
    return result;
}

/**
 * Pick the in-range map whose `version_code` is closest to the detected code
 * (or, with no detected code, the lowest code in range). Returns null when no
 * registered map falls inside the range. The closer-to-detected rule keeps
 * the pick intuitive when several maps qualify; ties break to the lower code,
 * then the lower label, so the result is deterministic.
 */
function pickByCodeRange(
    registry: RosettaMapRegistry,
    keys: readonly string[],
    range: { min?: number; max?: number },
    detectedCode: number | undefined,
): PickedMap | null {
    let best: { key: string; code: number } | null = null;
    for (const key of keys) {
        // `keys` comes from `Object.keys(registry)`, so the entry is defined;
        // the cast satisfies noUncheckedIndexedAccess (mirrors versionCodeIndex).
        const code = (registry[key] as RosettaMap).version_code;
        if (range.min !== undefined && code < range.min) continue;
        if (range.max !== undefined && code > range.max) continue;
        if (best === null || compareCodeCandidate(code, key, best, detectedCode) < 0) {
            best = { key, code };
        }
    }
    if (best === null) return null;
    return {
        map: registry[best.key] as RosettaMap,
        fromRegistry: true,
        fuzzy: true,
        registryKey: best.key,
        fuzzyKind: 'code-range',
    };
}

/** Order two in-range code candidates: closer-to-detected, then lower code, then label. */
function compareCodeCandidate(
    code: number,
    key: string,
    best: { key: string; code: number },
    detectedCode: number | undefined,
): number {
    if (detectedCode !== undefined) {
        const d = Math.abs(code - detectedCode) - Math.abs(best.code - detectedCode);
        if (d !== 0) return d;
    }
    if (code !== best.code) return code - best.code;
    return key < best.key ? -1 : 1;
}

/**
 * Pick the closest-by-distance map whose label parses into the inclusive
 * `[min, max]` label range. Returns null when no registered label falls in
 * range. Reuses the same lexicographic distance + tie-break as the nearest
 * fallback so the in-range pick is consistent with it.
 */
function pickByLabelRange(
    registry: RosettaMapRegistry,
    keys: readonly string[],
    version: string,
    range: { min?: string; max?: string },
    policy: VersionMatchConfig,
): PickedMap | null {
    const lo = range.min !== undefined ? parseVersion(range.min) : undefined;
    const hi = range.max !== undefined ? parseVersion(range.max) : undefined;
    const inRange = keys.filter((key) => {
        const v = parseVersion(key);
        if (lo !== undefined && compareTuple(v, lo) < 0) return false;
        if (hi !== undefined && compareTuple(v, hi) > 0) return false;
        return true;
    });
    if (inRange.length === 0) return null;
    const ranking = rankByDistance(parseVersion(version), inRange);
    const winner = ranking[0] as { key: string; distance: VersionTuple };
    return finishFuzzy(registry, winner.key, 'label-range', policy, ranking);
}

/** Rank keys closest-first by component-wise lexicographic distance to target. */
function rankByDistance(
    target: VersionTuple,
    keys: readonly string[],
): { key: string; distance: VersionTuple }[] {
    return keys
        .map((key) => ({ key, distance: versionDistance(target, parseVersion(key)) }))
        .sort((a, b) => compareDistance(a.distance, b.distance, a.key, b.key));
}

/** True when any component of the distance vector exceeds the ceiling. */
function exceedsMaxDistance(distance: VersionTuple, max: number): boolean {
    return distance[0] > max || distance[1] > max || distance[2] > max;
}

/** Lexicographic compare of two version tuples (major, then minor, then patch). */
function compareTuple(a: VersionTuple, b: VersionTuple): number {
    for (let i = 0; i < 3; i += 1) {
        const c = (a[i] as number) - (b[i] as number);
        if (c !== 0) return c;
    }
    return 0;
}

/** `[major, minor, patch]`; missing components default to 0. */
type VersionTuple = readonly [number, number, number];

/**
 * Parse a version string into a `[major, minor, patch]` tuple.
 *
 * Pre-release and build suffixes (`-alpha`, `+build42`) are stripped.
 * Non-numeric components are clamped to 0 so we always get a tuple.
 */
function parseVersion(version: string): VersionTuple {
    // `String.split` always returns at least one element, so [0] is always
    // defined — the cast keeps TypeScript happy under noUncheckedIndexedAccess.
    const stripped = version.split(/[-+]/, 1)[0] as string;
    const parts = stripped.split('.');
    const major = numeric(parts[0]);
    const minor = numeric(parts[1]);
    const patch = numeric(parts[2]);
    return [major, minor, patch];
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
function numeric(component: string | undefined): number {
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
 * Compared by {@link compareDistance}. Kotlin twin:
 * `VersionMatch.versionDistance`.
 */
function versionDistance(a: VersionTuple, b: VersionTuple): VersionTuple {
    return [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])];
}

/**
 * Total order over candidates: lexicographic on the distance vector
 * (major difference dominates, then minor, then patch), then the LOWER
 * parsed version, then the raw label string — so the pick is
 * deterministic even when two labels parse to the same tuple (e.g.
 * `'1.0.0'` vs `'1.0.0-rc1'`). Kotlin twin: `VersionMatch.compareDistance`.
 */
function compareDistance(
    distA: VersionTuple,
    distB: VersionTuple,
    labelA: string,
    labelB: string,
): number {
    for (let i = 0; i < 3; i += 1) {
        // `VersionTuple` is fixed-length [number, number, number], so each
        // index is defined; the cast appeases noUncheckedIndexedAccess.
        const c = (distA[i] as number) - (distB[i] as number);
        if (c !== 0) return c;
    }
    // Equal distance: prefer the lower actual version, then the raw label.
    const va = parseVersion(labelA);
    const vb = parseVersion(labelB);
    for (let i = 0; i < 3; i += 1) {
        const c = (va[i] as number) - (vb[i] as number);
        if (c !== 0) return c;
    }
    // Tuples equal — last-resort string compare keeps ties deterministic.
    // Object.keys guarantees the two are distinct strings (`labelA !== labelB`).
    return labelA < labelB ? -1 : 1;
}
