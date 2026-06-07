/**
 * Tests for the registry pick + version-matching helpers.
 */

import { describe, it, expect } from 'vitest';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { isRegistry, pickMapForVersion } from './version-match.js';

function buildMap(version: string, app = 'com.example.app', versionCode = 1): RosettaMap {
    return {
        schema_version: 2,
        version_code: versionCode,
        app,
        version,
        classes: {},
    };
}

describe('isRegistry', () => {
    it('returns false for a single RosettaMap', () => {
        expect(isRegistry(buildMap('1.0.0'))).toBe(false);
    });

    it('returns true for a registry record', () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
        };
        expect(isRegistry(reg)).toBe(true);
    });

    it('returns true for an empty registry (no schema_version present)', () => {
        // An empty object has no `schema_version` so it's treated as a
        // (degenerate) registry; the pick logic surfaces the emptiness.
        expect(isRegistry({})).toBe(true);
    });
});

describe('pickMapForVersion — single-map input', () => {
    it('returns the single map unchanged regardless of version', () => {
        const map = buildMap('1.2.3');
        const picked = pickMapForVersion(map, { version: 'whatever' });
        expect(picked.map).toBe(map);
        expect(picked.fromRegistry).toBe(false);
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBeUndefined();
    });
});

describe('pickMapForVersion — registry exact', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0'),
        '1.1.0': buildMap('1.1.0'),
        '2.0.0': buildMap('2.0.0'),
    };

    it('picks the exact match when present', () => {
        const picked = pickMapForVersion(registry, { version: '1.1.0' });
        expect(picked.map.version).toBe('1.1.0');
        expect(picked.fromRegistry).toBe(true);
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('throws if there is no exact match in default (exact) mode', () => {
        expect(() => pickMapForVersion(registry, { version: '3.0.0' })).toThrow(
            /no map for version '3\.0\.0'/,
        );
    });

    it('throws if there is no exact match in explicit exact mode', () => {
        expect(() =>
            pickMapForVersion(registry, { version: '3.0.0', versionMatch: 'exact' }),
        ).toThrow(/versionMatch: 'fuzzy'/);
    });

    it('throws on an empty registry', () => {
        expect(() => pickMapForVersion({}, { version: '1.0.0' })).toThrow(/registry is empty/);
    });
});

describe('pickMapForVersion — version_code (authoritative)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
        '1.1.0': buildMap('1.1.0', 'com.example.app', 110),
        '2.0.0': buildMap('2.0.0', 'com.example.app', 200),
    };

    it('selects by version_code regardless of the version label', () => {
        // Pass a label that would NOT exact-match, but a code that does.
        const picked = pickMapForVersion(registry, { version: 'whatever', versionCode: 110 });
        expect(picked.map.version).toBe('1.1.0');
        expect(picked.fromRegistry).toBe(true);
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('falls back to label matching when no map carries the detected code', () => {
        // Code 999 is absent → falls through to the exact-label path, which
        // finds '1.0.0'.
        const picked = pickMapForVersion(registry, { version: '1.0.0', versionCode: 999 });
        expect(picked.map.version).toBe('1.0.0');
        expect(picked.fuzzy).toBe(false);
    });

    it('falls through to the exact-label error when neither code nor label match', () => {
        expect(() => pickMapForVersion(registry, { version: '3.0.0', versionCode: 999 })).toThrow(
            /no map for version '3\.0\.0'/,
        );
    });

    it('returns the same map on repeated version_code lookups (memoised index)', () => {
        const a = pickMapForVersion(registry, { version: 'x', versionCode: 200 });
        const b = pickMapForVersion(registry, { version: 'y', versionCode: 200 });
        // Same registry object → memoised index → consistent O(1) result.
        expect(a.map).toBe(b.map);
        expect(a.registryKey).toBe('2.0.0');
        expect(b.registryKey).toBe('2.0.0');
    });

    it('keeps the first key when two maps share a version_code', () => {
        const dupRegistry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 500),
            '1.0.1': buildMap('1.0.1', 'com.example.app', 500),
        };
        const picked = pickMapForVersion(dupRegistry, { version: 'z', versionCode: 500 });
        expect(picked.registryKey).toBe('1.0.0');
    });
});

describe('pickMapForVersion — fuzzy', () => {
    it('picks the closest version when no exact match exists', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.1.1',
            versionMatch: 'fuzzy',
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('ranks 1.0.142 above 1.1.42 (lexicographic, not weighted-sum: f13/xposed#13)', () => {
        // The OLD weighted-sum metric (major*10000 + minor*100 + patch)
        // collapsed both candidates to the SAME distance from target 1.0.0:
        //   1.0.142 → |Δ| = 0*10000 + 0*100 + 142 = 142
        //   1.1.42  → |Δ| = 0*10000 + 1*100 + 42  = 142
        // so the pick was a coin-flip decided by the tie-break, and could
        // wrongly land on 1.1.42. Component-wise LEXICOGRAPHIC distance ranks
        // 1.0.142 (Δ = [0,0,142]) strictly below 1.1.42 (Δ = [0,1,42])
        // because the minor delta dominates — the correct, intuitive pick.
        const registry: RosettaMapRegistry = {
            '1.1.42': buildMap('1.1.42'),
            '1.0.142': buildMap('1.0.142'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.registryKey).toBe('1.0.142');
    });

    it('ranks 1.0.142 above 1.1.42 regardless of insertion order', () => {
        // Same as above with the registry keys inserted in the opposite
        // order, proving the pick is order-independent (not an artifact of
        // first-seen iteration).
        const registry: RosettaMapRegistry = {
            '1.0.142': buildMap('1.0.142'),
            '1.1.42': buildMap('1.1.42'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.142');
    });

    it('picks the lower version on a tie (deterministic tie-break)', () => {
        // 1.0.0 is equidistant from 0.0.0 and 2.0.0 in component-wise distance
        // (Δ = [1,0,0] either way) — the lower key wins.
        const registry: RosettaMapRegistry = {
            '0.0.0': buildMap('0.0.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('0.0.0');
    });

    it('tie-break compares minor components when major is equal', () => {
        // 1.5.0 equidistant from 1.0.0 (Δ=[0,5,0]) and 1.10.0 (Δ=[0,5,0]) →
        // distance ties, so the lower version 1.0.0 wins.
        const registry: RosettaMapRegistry = {
            '1.10.0': buildMap('1.10.0'),
            '1.0.0': buildMap('1.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.5.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('tie-break compares patch components when major+minor are equal', () => {
        // 1.0.5 equidistant from 1.0.0 (Δ=[0,0,5]) and 1.0.10 (Δ=[0,0,5]) →
        // distance ties, so the lower version 1.0.0 wins.
        const registry: RosettaMapRegistry = {
            '1.0.10': buildMap('1.0.10'),
            '1.0.0': buildMap('1.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.5',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('tie-break falls back to string compare when tuples are equal', () => {
        // Both '1.0.0' and '1.0.0-rc1' parse to [1, 0, 0]; they have
        // identical distance to any target. The string-compare fallback
        // picks the lexicographically-smaller key ('1.0.0' before
        // '1.0.0-rc1') so the result stays deterministic.
        const registry: RosettaMapRegistry = {
            '1.0.0-rc1': buildMap('1.0.0-rc1'),
            '1.0.0': buildMap('1.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '2.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('the string fallback also breaks ties in the reverse direction', () => {
        // Mirror the above with keys swapped so we exercise the `a > b`
        // branch of the string fallback. Insertion order is irrelevant
        // (Object.keys order is preserved but the comparison is
        // commutative for `pickMapForVersion`).
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.0.0-rc1': buildMap('1.0.0-rc1'),
        };
        const picked = pickMapForVersion(registry, {
            version: '2.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('still prefers exact match in fuzzy mode when one is available', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.5.0': buildMap('1.5.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.5.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBe('1.5.0');
    });

    it('handles single-component versions', () => {
        const registry: RosettaMapRegistry = {
            '1': buildMap('1'),
            '2': buildMap('2'),
        };
        const picked = pickMapForVersion(registry, {
            version: '3',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('2');
    });

    it('strips pre-release / build suffixes for comparison', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.5-rc1+build9',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('treats non-numeric components as 0', () => {
        // 'foo.bar.baz' parses to [0, 0, 0] so the closest entry is whichever
        // key parses closest to [0, 0, 0]: 1.0.0 (Δ=[1,0,0]) beats 2.0.0
        // (Δ=[2,0,0]).
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: 'foo.bar.baz',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('parses a partially-numeric component strictly (12abc -> 0), matching Kotlin', () => {
        // Kotlin's `String.toIntOrNull()` returns null for "12abc" (→ 0), so a
        // schema-valid label like '1.12abc.3' parses to [1, 0, 3] on BOTH
        // clients. The OLD lenient `Number.parseInt('12abc', 10)` yielded 12 →
        // [1, 12, 3] on the Frida side only, which would diverge the fuzzy
        // pick. For target 1.11.0:
        //   strict:  1.12abc.3 → [1,0,3]  Δ=[0,11,3]   1.9.0 → [1,9,0] Δ=[0,2,0]
        //            → 1.9.0 wins (the agreed answer)
        //   lenient: 1.12abc.3 → [1,12,3] Δ=[0,1,3]    → would wrongly pick it
        // This case is also pinned in the shared version-select.json fixture.
        const registry: RosettaMapRegistry = {
            '1.12abc.3': buildMap('1.12abc.3'),
            '1.9.0': buildMap('1.9.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.11.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.9.0');
    });

    it('treats an out-of-Int-range component as 0 (overflow), matching Kotlin', () => {
        // 4294967296 (= 2^32, > Int.MAX_VALUE 2147483647) is null under
        // `toIntOrNull()` → 0, where lenient parseInt keeps the huge number.
        // '1.4294967296.0' therefore parses to [1, 0, 0]; for target 1.0.0 that
        // is an exact-tuple match (Δ=[0,0,0]) and beats 2.0.0 (Δ=[1,0,0]).
        const registry: RosettaMapRegistry = {
            '1.4294967296.0': buildMap('1.4294967296.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.0',
            versionMatch: 'fuzzy',
        });
        expect(picked.registryKey).toBe('1.4294967296.0');
    });

    it('accepts exactly Int.MAX_VALUE as a numeric component', () => {
        // 2147483647 is the boundary (still a valid Int), so it contributes its
        // value: '0.2147483647.0' → [0, 2147483647, 0]. For target with the
        // same minor it is the closest entry.
        const registry: RosettaMapRegistry = {
            '0.2147483647.0': buildMap('0.2147483647.0'),
            '0.0.0': buildMap('0.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '0.2147483647.0',
            versionMatch: 'fuzzy',
        });
        // exact label match short-circuits fuzzy
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBe('0.2147483647.0');
    });
});
