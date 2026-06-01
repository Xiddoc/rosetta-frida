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
 *      supplies a detected/overridden `versionCode`, we scan the
 *      registry values for the map whose `version_code` equals it and
 *      return that map regardless of its label. This is exact, never
 *      fuzzy.
 *   2. version *label* — the fallback when no `versionCode` is available
 *      or no map carries the detected code. Behaves as before:
 *      - 'exact' (default) — registry must contain an entry whose key
 *        equals the version label. No match → throw.
 *      - 'fuzzy' — fall back to the closest available label by
 *        major-minor-patch distance (user opts in via
 *        `versionMatch: 'fuzzy'`).
 *
 * Fuzzy comparison is intentionally simple: we parse each version into
 * a numeric `[major, minor, patch]` tuple (defaulting missing
 * components to 0, ignoring pre-release / build suffixes). Distance is
 * the absolute difference summed across components, weighted by
 * positional significance (major × 10_000 + minor × 100 + patch). This
 * is enough to make adjacent point releases collapse onto each other
 * while still preferring closer-numbered versions across larger gaps.
 * If two candidates tie, the lower version wins (deterministic).
 */

import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import type { VersionMatch } from '../types/session.js';

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
    /** Version-label-matching mode. Defaults to 'exact'. */
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
    { version, versionCode, versionMatch = 'exact' }: PickMapOptions,
): PickedMap {
    if (!isRegistry(input)) {
        return { map: input, fromRegistry: false, fuzzy: false };
    }

    const keys = Object.keys(input);
    if (keys.length === 0) {
        throw new Error(
            `rosetta-frida: map registry is empty — cannot pick a map for version '${version}'.`,
        );
    }

    // 1. Authoritative selection by version_code (RFC 0001 Decision 3).
    if (versionCode !== undefined) {
        for (const key of keys) {
            const candidate = input[key];
            if (candidate && candidate.version_code === versionCode) {
                return { map: candidate, fromRegistry: true, fuzzy: false, registryKey: key };
            }
        }
        // No map carries the detected code — fall through to label matching,
        // which surfaces a precise error (or fuzzy fallback) below.
    }

    // 2. Fallback selection by version label.
    const exact = input[version];
    if (exact !== undefined) {
        return { map: exact, fromRegistry: true, fuzzy: false, registryKey: version };
    }

    if (versionMatch !== 'fuzzy') {
        throw new Error(
            `rosetta-frida: no map for version '${version}' in registry (available: ${keys
                .sort()
                .join(', ')}). Pass versionMatch: 'fuzzy' to fall back to the closest map.`,
        );
    }

    const target = parseVersion(version);
    let best: { key: string; distance: number } | null = null;
    for (const key of keys) {
        const distance = versionDistance(target, parseVersion(key));
        if (
            best === null ||
            distance < best.distance ||
            (distance === best.distance && compareKeys(key, best.key) < 0)
        ) {
            best = { key, distance };
        }
    }

    // `keys.length > 0` was checked above, so `best` is non-null here.
    const picked = best as { key: string; distance: number };
    return {
        map: input[picked.key] as RosettaMap,
        fromRegistry: true,
        fuzzy: true,
        registryKey: picked.key,
    };
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

function numeric(component: string | undefined): number {
    if (component === undefined || component === '') return 0;
    const n = Number.parseInt(component, 10);
    return Number.isFinite(n) ? n : 0;
}

/** Distance between two version tuples (lower is closer). */
function versionDistance(a: VersionTuple, b: VersionTuple): number {
    return Math.abs(a[0] - b[0]) * 10_000 + Math.abs(a[1] - b[1]) * 100 + Math.abs(a[2] - b[2]);
}

/**
 * Lexicographic on numeric components — deterministic tie-break.
 *
 * Two distinct keys can still parse to the same tuple (e.g. `'1.0.0'` and
 * `'1.0.0-rc1'` both parse to `[1, 0, 0]`); when that happens we fall
 * back to a string comparison so the result is still total.
 */
function compareKeys(a: string, b: string): number {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    for (let i = 0; i < 3; i += 1) {
        // `VersionTuple` is fixed-length [number, number, number], so each
        // index is defined; the cast appeases noUncheckedIndexedAccess.
        const ai = va[i] as number;
        const bi = vb[i] as number;
        if (ai !== bi) return ai - bi;
    }
    // Tuples equal — last-resort string compare keeps ties deterministic.
    // Object.keys guarantees the two are distinct strings (`a !== b`).
    return a < b ? -1 : 1;
}
