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
import { compareTuple, parseVersion, versionDistance, type VersionTuple } from './version-tuple.js';

/** A single ranked fuzzy candidate, exposed when `ranked` is opted-in. */
export interface RankedCandidate {
    /** The registry key (version label) of this candidate. */
    registryKey: string;
    /** Component-wise distance `[|Δmajor|, |Δminor|, |Δpatch|]` to the target. */
    distance: readonly [number, number, number];
}

/**
 * Which selection tier produced a pick.
 *
 * `'exact'` — an exact `version_code` or label match (also the kind for a
 * single-map input). The four kinds are kept DISTINCT (rather than collapsed
 * to one `fuzzy` boolean) so the post-pick acceptance guard, callers, and
 * emitted events can tell a far-but-deliberate range pick apart from a
 * nearest-label fallback (issue #22 major gap 2). `fuzzy === (fuzzyKind !==
 * 'exact')`.
 */
export type FuzzyKind = 'exact' | 'nearest' | 'code-range' | 'label-range';

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
     * Which tier selected this map. `'exact'` for a `version_code` / label
     * match (and for a single-map input); `'nearest'` is the legacy
     * closest-label pick; `'code-range'` / `'label-range'` are the opt-in
     * range fallbacks. Always present so the five tiers stay distinguishable
     * downstream (not collapsed to the `fuzzy` boolean).
     */
    fuzzyKind: FuzzyKind;
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

/**
 * Guarded registry read. Every internal access uses a key that came from
 * `Object.keys(registry)` / the memoised index, so the entry is always
 * present — but a single `getMap` helper gives a uniform safety posture (one
 * throw site instead of scattered `as RosettaMap` casts that would silently
 * paper over a genuinely-missing key under `noUncheckedIndexedAccess`).
 */
function getMap(registry: RosettaMapRegistry, key: string): RosettaMap {
    const map = registry[key];
    if (map === undefined) {
        // Unreachable for keys sourced from Object.keys/the index; the guard
        // exists so a future caller passing a stale key fails loudly here.
        throw new Error(`rosetta-frida: registry has no entry for key '${key}'.`);
    }
    return map;
}

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
        return { map: input, fromRegistry: false, fuzzy: false, fuzzyKind: 'exact' };
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
            return {
                map: getMap(input, key),
                fromRegistry: true,
                fuzzy: false,
                registryKey: key,
                fuzzyKind: 'exact',
            };
        }
        // No map carries the detected code — fall through to label matching,
        // which surfaces a precise error (or fuzzy fallback) below.
    }

    // 2. Fallback selection by version label (exact).
    const exact = input[version];
    if (exact !== undefined) {
        return {
            map: exact,
            fromRegistry: true,
            fuzzy: false,
            registryKey: version,
            fuzzyKind: 'exact',
        };
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
    assertWithinMaxDistance(version, winner, keys, policy.maxDistance);

    return finishFuzzy(input, winner.key, 'nearest', policy, ranking);
}

/**
 * Build a {@link PickedMap} for a fuzzy winner, attaching ranked candidates
 * when the caller opted in.
 */
function finishFuzzy(
    registry: RosettaMapRegistry,
    key: string,
    fuzzyKind: Exclude<FuzzyKind, 'exact'>,
    policy: VersionMatchConfig,
    ranking?: readonly { key: string; distance: VersionTuple }[],
): PickedMap {
    const result: PickedMap = {
        map: getMap(registry, key),
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
        const code = getMap(registry, key).version_code;
        if (range.min !== undefined && code < range.min) continue;
        if (range.max !== undefined && code > range.max) continue;
        if (best === null || compareCodeCandidate(code, key, best, detectedCode) < 0) {
            best = { key, code };
        }
    }
    if (best === null) return null;
    return {
        map: getMap(registry, best.key),
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
    // A label range is distance-ranked, so the LABEL-distance ceiling applies
    // here too (issue #22 design ruling): an in-range winner that is still too
    // far fails loudly rather than silently accepting a distant map.
    assertWithinMaxDistance(version, winner, keys, policy.maxDistance);
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

/**
 * Enforce the opt-in LABEL-distance ceiling on a distance-ranked winner,
 * throwing a loud error when it is exceeded. Shared by the nearest-label tier
 * and the label-range tier so both gate identically. `null` / `undefined`
 * ceiling is a no-op (legacy "always pick the closest").
 *
 * The ceiling uses the SAME major-dominant lexicographic metric as the
 * ranking (see {@link exceedsMaxDistance}), so "accepted" is exactly "ranked
 * no worse than a hypothetical `[maxDistance, 0, 0]` candidate".
 */
function assertWithinMaxDistance(
    version: string,
    winner: { key: string; distance: VersionTuple },
    keys: readonly string[],
    maxDistance: number | null | undefined,
): void {
    if (maxDistance === null || maxDistance === undefined) return;
    if (!exceedsMaxDistance(winner.distance, maxDistance)) return;
    throw new Error(
        `rosetta-frida: closest map for version '${version}' is '${winner.key}' ` +
            `(distance [${winner.distance.join(', ')}]), which exceeds the configured ` +
            `maxDistance of ${maxDistance}. No acceptable map in registry ` +
            `(available: ${[...keys].sort().join(', ')}).`,
    );
}

/**
 * True when the distance tuple exceeds the ceiling under the SAME
 * major-dominant lexicographic order used to rank candidates.
 *
 * The ceiling is a single MAJOR-dominant number: a distance is acceptable iff
 * it compares `<=` the tuple `[maxDistance, 0, 0]` lexicographically. So
 * `maxDistance: 1` accepts `[0, 99, 99]` and `[1, 0, 0]` but rejects
 * `[1, 0, 1]` and `[2, 0, 0]`. The OLD per-component check
 * (`d0 > max || d1 > max || d2 > max`) was inconsistent with the ranking — it
 * rejected `[0, 0, 5]` yet accepted `[1, 0, 0]` at `maxDistance: 1` — which is
 * the counterintuitive case issue #22 calls out.
 */
function exceedsMaxDistance(distance: VersionTuple, max: number): boolean {
    return compareTuple(distance, [max, 0, 0]) > 0;
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
    // Both the distance ordering and the version tie-break are lexicographic
    // 3-component compares, so they reuse the one shared `compareTuple`.
    const byDistance = compareTuple(distA, distB);
    if (byDistance !== 0) return byDistance;
    // Equal distance: prefer the lower actual version, then the raw label.
    const byVersion = compareTuple(parseVersion(labelA), parseVersion(labelB));
    if (byVersion !== 0) return byVersion;
    // Tuples equal — last-resort string compare keeps ties deterministic.
    // Object.keys guarantees the two are distinct strings (`labelA !== labelB`).
    return labelA < labelB ? -1 : 1;
}
