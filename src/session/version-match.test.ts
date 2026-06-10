/**
 * Tests for the registry pick + version-matching helpers.
 */

import { describe, it, expect } from 'vitest';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { isRegistry, pickMapForVersion } from './version-match.js';

function buildMap(version: string, app = 'com.example.app', versionCode = 1): RosettaMap {
    return {
        schema_version: 4,
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

    it('FIRST-WINS on a version_code collision (cross-client canonical policy)', () => {
        // When two maps share a version_code, the FIRST key in iteration
        // order claims it and the second NEVER overwrites it. This is the
        // canonical collision policy shared with the Kotlin rosetta-xposed
        // loader (putIfAbsent) so a duplicate-laden bundle resolves to the
        // same map on both clients.
        const dupRegistry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 500),
            '1.0.1': buildMap('1.0.1', 'com.example.app', 500),
        };
        const picked = pickMapForVersion(dupRegistry, { version: 'z', versionCode: 500 });
        expect(picked.registryKey).toBe('1.0.0');
        expect(picked.map.version).toBe('1.0.0');
    });

    it('FIRST-WINS is insertion-order, not label-sorted', () => {
        // The winner is the first inserted key, even when its label sorts
        // AFTER the colliding one — proving the policy is "first in iteration
        // order", not "lowest label".
        const dupRegistry: RosettaMapRegistry = {
            zzz: buildMap('9.9.9', 'com.example.app', 700),
            aaa: buildMap('1.0.0', 'com.example.app', 700),
        };
        const picked = pickMapForVersion(dupRegistry, { version: 'q', versionCode: 700 });
        expect(picked.registryKey).toBe('zzz');
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

    it('sets fuzzyKind: "nearest" on a closest-label pick', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const picked = pickMapForVersion(registry, { version: '1.5.0', versionMatch: 'fuzzy' });
        expect(picked.fuzzyKind).toBe('nearest');
        expect(picked.ranked).toBeUndefined();
    });
});

describe('pickMapForVersion — object-form versionMatch', () => {
    it('treats { strategy: "fuzzy" } identically to the "fuzzy" string', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.1.1',
            versionMatch: { strategy: 'fuzzy' },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('{ strategy: "exact" } fails loudly on a miss (fail-hard-by-default)', () => {
        const registry: RosettaMapRegistry = { '1.0.0': buildMap('1.0.0') };
        expect(() =>
            pickMapForVersion(registry, { version: '2.0.0', versionMatch: { strategy: 'exact' } }),
        ).toThrow(/no map for version '2\.0\.0'/);
    });

    it('an empty object form defaults to exact and fails loudly on a miss', () => {
        const registry: RosettaMapRegistry = { '1.0.0': buildMap('1.0.0') };
        expect(() => pickMapForVersion(registry, { version: '2.0.0', versionMatch: {} })).toThrow(
            /no map for version '2\.0\.0'/,
        );
    });
});

describe('pickMapForVersion — maxDistance ceiling (opt-in)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0'),
        '5.0.0': buildMap('5.0.0'),
    };

    it('accepts a pick within the ceiling', () => {
        const picked = pickMapForVersion(registry, {
            version: '1.1.0',
            versionMatch: { strategy: 'fuzzy', maxDistance: 1 },
        });
        expect(picked.registryKey).toBe('1.0.0');
        expect(picked.fuzzy).toBe(true);
    });

    it('rejects a pick beyond the ceiling and fails loudly', () => {
        expect(() =>
            pickMapForVersion(registry, {
                version: '3.0.0', // closest is 1.0.0 at Δmajor=2 (or 5.0.0 at Δ=2 → tie, lower wins)
                versionMatch: { strategy: 'fuzzy', maxDistance: 1 },
            }),
        ).toThrow(/exceeds the configured maxDistance of 1/);
    });

    it('maxDistance: 0 means only a zero-distance (tuple-equal) pick is allowed', () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.0.0-rc1': buildMap('1.0.0-rc1'),
        };
        // '1.0.0-rc1' parses to [1,0,0] — zero distance to target '1.0.0', but
        // not an exact LABEL match, so it goes through fuzzy and is accepted.
        const picked = pickMapForVersion(reg, {
            version: '1.0.0-rc1-extra',
            versionMatch: { strategy: 'fuzzy', maxDistance: 0 },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('null maxDistance imposes no ceiling (legacy behaviour)', () => {
        const picked = pickMapForVersion(registry, {
            version: '99.0.0',
            versionMatch: { strategy: 'fuzzy', maxDistance: null },
        });
        expect(picked.registryKey).toBe('5.0.0');
    });
});

describe('pickMapForVersion — ranked candidates (opt-in)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0'),
        '1.1.0': buildMap('1.1.0'),
        '2.0.0': buildMap('2.0.0'),
    };

    it('omits ranked by default', () => {
        const picked = pickMapForVersion(registry, { version: '1.0.5', versionMatch: 'fuzzy' });
        expect(picked.ranked).toBeUndefined();
    });

    it('exposes ranked candidates closest-first when opted in', () => {
        const picked = pickMapForVersion(registry, {
            version: '1.0.5',
            versionMatch: { strategy: 'fuzzy', ranked: true },
        });
        expect(picked.ranked).toBeDefined();
        const keys = picked.ranked?.map((c) => c.registryKey);
        // Closest to 1.0.5: 1.0.0 (Δ=[0,0,5]) then 1.1.0 (Δ=[0,1,0]) then 2.0.0.
        expect(keys).toEqual(['1.0.0', '1.1.0', '2.0.0']);
        expect(picked.registryKey).toBe('1.0.0');
        expect(picked.ranked?.[0]?.distance).toEqual([0, 0, 5]);
    });
});

describe('pickMapForVersion — versionCodeRange (opt-in)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
        '1.1.0': buildMap('1.1.0', 'com.example.app', 110),
        '2.0.0': buildMap('2.0.0', 'com.example.app', 200),
    };

    it('selects an in-range map by closeness to the detected code', () => {
        // Detected code 130 is absent; range [100,200] qualifies all three;
        // closest by code to 130 is 110.
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 130,
            versionMatch: { versionCodeRange: { min: 100, max: 200 } },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.fuzzyKind).toBe('code-range');
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('selects the lowest in-range code when no code is detected', () => {
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionMatch: { versionCodeRange: { min: 110 } },
        });
        expect(picked.registryKey).toBe('1.1.0');
    });

    it('honours an upper bound', () => {
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionMatch: { versionCodeRange: { max: 100 } },
        });
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('falls through (fails loudly) when nothing is in range and strategy is exact', () => {
        expect(() =>
            pickMapForVersion(registry, {
                version: 'x',
                versionMatch: { versionCodeRange: { min: 300 } },
            }),
        ).toThrow(/no map for version 'x'/);
    });

    it('exact version_code still wins over a configured range', () => {
        // Detected code 200 exact-matches 2.0.0; the range would otherwise
        // prefer a code near nothing — exact precedence holds.
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 200,
            versionMatch: { versionCodeRange: { min: 100, max: 110 } },
        });
        expect(picked.fuzzy).toBe(false);
        expect(picked.registryKey).toBe('2.0.0');
    });

    it('breaks an equidistant code tie to the lower code', () => {
        const reg: RosettaMapRegistry = {
            low: buildMap('1.0.0', 'com.example.app', 100),
            high: buildMap('1.1.0', 'com.example.app', 120),
        };
        // Detected 110 is equidistant (10) from 100 and 120 → lower code wins.
        const picked = pickMapForVersion(reg, {
            version: 'x',
            versionCode: 110,
            versionMatch: { versionCodeRange: { min: 100, max: 120 } },
        });
        expect(picked.registryKey).toBe('low');
    });

    it('breaks a full tie (same code, no detected code) to the lower label', () => {
        const reg: RosettaMapRegistry = {
            bbb: buildMap('1.1.0', 'com.example.app', 100),
            aaa: buildMap('1.0.0', 'com.example.app', 100),
        };
        const picked = pickMapForVersion(reg, {
            version: 'x',
            versionMatch: { versionCodeRange: { min: 100, max: 100 } },
        });
        expect(picked.registryKey).toBe('aaa');
    });

    it('full-tie break is order-independent (lower label wins either insertion order)', () => {
        // Mirror of the above with keys inserted in the opposite order, so the
        // comparator's "keep current best" (returns +1) branch is exercised:
        // best=aaa first, then bbb does NOT replace it.
        const reg: RosettaMapRegistry = {
            aaa: buildMap('1.0.0', 'com.example.app', 100),
            bbb: buildMap('1.1.0', 'com.example.app', 100),
        };
        const picked = pickMapForVersion(reg, {
            version: 'x',
            versionMatch: { versionCodeRange: { min: 100, max: 100 } },
        });
        expect(picked.registryKey).toBe('aaa');
    });
});

describe('pickMapForVersion — versionRange (opt-in label range)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0'),
        '1.5.0': buildMap('1.5.0'),
        '2.0.0': buildMap('2.0.0'),
        '3.0.0': buildMap('3.0.0'),
    };

    it('picks the closest in-range label by component-wise distance', () => {
        // Range [1.0.0, 2.0.0] qualifies 1.0.0, 1.5.0, 2.0.0; target 1.9.0 →
        // closest is 1.5.0 (Δ=[0,4,0]) over 2.0.0 (Δ=[1,9,0]) and 1.0.0
        // (Δ=[0,9,0]) — the major-delta on 2.0.0 dominates.
        const picked = pickMapForVersion(registry, {
            version: '1.9.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' } },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.fuzzyKind).toBe('label-range');
        expect(picked.registryKey).toBe('1.5.0');
    });

    it('excludes out-of-range labels (3.0.0 ignored by the upper bound)', () => {
        const picked = pickMapForVersion(registry, {
            version: '2.0.0-pre', // [2,0,0]; 3.0.0 is excluded by max '2.0.0'
            versionMatch: { versionRange: { max: '2.0.0' } },
        });
        // Eligible: 1.0.0/1.5.0/2.0.0; exact-tuple match is 2.0.0 (Δ=[0,0,0]).
        expect(picked.registryKey).toBe('2.0.0');
    });

    it('honours a lower-only bound', () => {
        const picked = pickMapForVersion(registry, {
            version: '2.9.0',
            versionMatch: { versionRange: { min: '2.0.0' } },
        });
        // 2.0.0 (Δ=[0,9,0]) / 3.0.0 (Δ=[1,9,0]) eligible; the lower major
        // delta makes 2.0.0 the closest.
        expect(picked.registryKey).toBe('2.0.0');
    });

    it('fails loudly when nothing is in the label range (strategy exact)', () => {
        expect(() =>
            pickMapForVersion(registry, {
                version: '1.0.0-x',
                versionMatch: { versionRange: { min: '9.0.0' } },
            }),
        ).toThrow(/no map for version/);
    });

    it('exposes ranked candidates within the range when opted in', () => {
        const picked = pickMapForVersion(registry, {
            version: '1.9.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' }, ranked: true },
        });
        // Closest-first by component-wise distance to 1.9.0:
        //   1.5.0 [0,4,0] < 1.0.0 [0,9,0] < 2.0.0 [1,9,0].
        expect(picked.ranked?.map((c) => c.registryKey)).toEqual(['1.5.0', '1.0.0', '2.0.0']);
    });

    it('code range takes priority over a label range when both are set', () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
            '2.0.0': buildMap('2.0.0', 'com.example.app', 200),
        };
        // version_code range pins 100 (1.0.0); the label range would prefer
        // 2.0.0 for target 9.0.0 — but code-range runs first and wins.
        const picked = pickMapForVersion(reg, {
            version: '9.0.0',
            versionMatch: {
                versionCodeRange: { max: 100 },
                versionRange: { min: '2.0.0' },
            },
        });
        expect(picked.fuzzyKind).toBe('code-range');
        expect(picked.registryKey).toBe('1.0.0');
    });
});

describe('pickMapForVersion — maxDistance is major-dominant lexicographic', () => {
    it('accepts a high-patch low-major pick at maxDistance 1 (the previously-counterintuitive case)', () => {
        // Δ=[0,0,5] for target 1.0.0 → 1.0.5. Under the OLD per-component check
        // this was REJECTED at maxDistance:1 (patch 5 > 1), yet a [1,0,0] pick
        // would have been ACCEPTED — inconsistent with the ranking, which puts
        // [0,0,5] strictly ahead of [1,0,0]. The lexicographic ceiling now
        // accepts it (major delta 0 <= 1).
        const reg: RosettaMapRegistry = {
            '1.0.5': buildMap('1.0.5'),
            '9.0.0': buildMap('9.0.0'),
        };
        const picked = pickMapForVersion(reg, {
            version: '1.0.0',
            versionMatch: { strategy: 'fuzzy', maxDistance: 1 },
        });
        expect(picked.registryKey).toBe('1.0.5');
        expect(picked.fuzzyKind).toBe('nearest');
    });

    it('accepts a distance exactly equal to [maxDistance, 0, 0]', () => {
        // Δ=[1,0,0] is the boundary: compareTuple([1,0,0],[1,0,0])===0 → accepted.
        const reg: RosettaMapRegistry = { '2.0.0': buildMap('2.0.0') };
        const picked = pickMapForVersion(reg, {
            version: '1.0.0',
            versionMatch: { strategy: 'fuzzy', maxDistance: 1 },
        });
        expect(picked.registryKey).toBe('2.0.0');
    });

    it('rejects a distance one past the boundary ([1,0,1] at maxDistance 1)', () => {
        // Δ=[1,0,1] for target 1.0.0 → 2.0.1. Lexicographically > [1,0,0] so it
        // is rejected even though the major delta equals the ceiling.
        const reg: RosettaMapRegistry = { '2.0.1': buildMap('2.0.1') };
        expect(() =>
            pickMapForVersion(reg, {
                version: '1.0.0',
                versionMatch: { strategy: 'fuzzy', maxDistance: 1 },
            }),
        ).toThrow(/exceeds the configured maxDistance of 1/);
    });
});

describe('pickMapForVersion — maxDistance applies to a label range', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0'),
        '1.9.0': buildMap('1.9.0'),
        '2.0.0': buildMap('2.0.0'),
    };

    it('accepts an in-range label pick within the ceiling', () => {
        // Range [1.0.0, 2.0.0]; target 1.9.5 → closest is 1.9.0 (Δ=[0,0,5]);
        // major delta 0 <= 1 → accepted.
        const picked = pickMapForVersion(registry, {
            version: '1.9.5',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' }, maxDistance: 1 },
        });
        expect(picked.fuzzyKind).toBe('label-range');
        expect(picked.registryKey).toBe('1.9.0');
    });

    it('rejects an in-range label pick beyond the ceiling and fails loudly', () => {
        // Range [1.0.0, 2.0.0]; target 1.0.0 missing, but force a far winner:
        // only 2.0.0 in range, Δ=[1,9,0] for target 0.0.0... use a clearer case.
        const reg: RosettaMapRegistry = {
            '5.0.0': buildMap('5.0.0'),
            '6.0.0': buildMap('6.0.0'),
        };
        // Range admits both; target 1.0.0 → closest 5.0.0 (Δ=[4,0,0]) > [1,0,0].
        expect(() =>
            pickMapForVersion(reg, {
                version: '1.0.0',
                versionMatch: { versionRange: { min: '5.0.0', max: '6.0.0' }, maxDistance: 1 },
            }),
        ).toThrow(/exceeds the configured maxDistance of 1/);
    });
});

describe('pickMapForVersion — ranges are independently opt-in (strategy off)', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
        '2.0.0': buildMap('2.0.0', 'com.example.app', 200),
    };

    it('a versionCodeRange engages with no strategy (defaults to exact)', () => {
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 130,
            versionMatch: { versionCodeRange: { min: 100, max: 200 } },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.fuzzyKind).toBe('code-range');
    });

    it('a versionCodeRange engages with an explicit exact strategy', () => {
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 130,
            versionMatch: { strategy: 'exact', versionCodeRange: { min: 100, max: 200 } },
        });
        expect(picked.fuzzyKind).toBe('code-range');
    });

    it('a versionRange engages with no strategy (defaults to exact)', () => {
        const picked = pickMapForVersion(registry, {
            version: '1.5.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' } },
        });
        expect(picked.fuzzy).toBe(true);
        expect(picked.fuzzyKind).toBe('label-range');
    });

    it('a versionRange engages with an explicit exact strategy', () => {
        const picked = pickMapForVersion(registry, {
            version: '1.5.0',
            versionMatch: { strategy: 'exact', versionRange: { min: '1.0.0', max: '2.0.0' } },
        });
        expect(picked.fuzzyKind).toBe('label-range');
    });
});

describe('pickMapForVersion — fuzzyKind on exact picks', () => {
    it('reports "exact" for a single-map input', () => {
        const picked = pickMapForVersion(buildMap('1.0.0'), { version: 'whatever' });
        expect(picked.fuzzyKind).toBe('exact');
    });

    it('reports "exact" for a version_code match', () => {
        const reg: RosettaMapRegistry = { '1.0.0': buildMap('1.0.0', 'com.example.app', 100) };
        const picked = pickMapForVersion(reg, { version: 'x', versionCode: 100 });
        expect(picked.fuzzyKind).toBe('exact');
    });

    it('reports "exact" for a version-label match', () => {
        const reg: RosettaMapRegistry = { '1.0.0': buildMap('1.0.0') };
        const picked = pickMapForVersion(reg, { version: '1.0.0' });
        expect(picked.fuzzyKind).toBe('exact');
    });
});

describe('pickMapForVersion — versionCodeRange with detected code OUTSIDE the range', () => {
    const registry: RosettaMapRegistry = {
        '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
        '1.1.0': buildMap('1.1.0', 'com.example.app', 110),
        '2.0.0': buildMap('2.0.0', 'com.example.app', 200),
    };

    it('still picks the in-range map closest to the (out-of-range, higher) detected code', () => {
        // Detected 500 is ABOVE the [100,150] range; the closest in-range code
        // to 500 is the highest one, 110 — "closest to detected" stays sane.
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 500,
            versionMatch: { versionCodeRange: { min: 100, max: 150 } },
        });
        expect(picked.registryKey).toBe('1.1.0');
        expect(picked.fuzzyKind).toBe('code-range');
    });

    it('picks the lowest in-range code when the detected code is below the range', () => {
        // Detected 5 is BELOW [150,250]; only 200 qualifies and is closest.
        const picked = pickMapForVersion(registry, {
            version: 'x',
            versionCode: 5,
            versionMatch: { versionCodeRange: { min: 150, max: 250 } },
        });
        expect(picked.registryKey).toBe('2.0.0');
    });
});

describe('pickMapForVersion — suffixed range bounds collapse to the numeric tuple', () => {
    it('treats a min bound suffix (-rc) as its numeric tuple', () => {
        // '1.0.0-rc1' parses to [1,0,0]; 1.0.0 is therefore IN range [1.0.0-rc1, …].
        const registry: RosettaMapRegistry = {
            '0.9.0': buildMap('0.9.0'),
            '1.0.0': buildMap('1.0.0'),
        };
        const picked = pickMapForVersion(registry, {
            version: '1.0.0-x',
            versionMatch: { versionRange: { min: '1.0.0-rc1' } },
        });
        // 0.9.0 ([0,9,0]) is below the [1,0,0] min and excluded; only 1.0.0 left.
        expect(picked.registryKey).toBe('1.0.0');
    });

    it('rejects an inverted suffixed range via the parse-time refinement', () => {
        // Bounds '2.0.0+build' ([2,0,0]) min and '1.0.0' ([1,0,0]) max compare
        // inverted at the numeric-tuple level. resolveVersionMatch (run inside
        // pickMapForVersion) validates the range and fails loudly — the suffix
        // strip means config-time validation sees the same tuples the runtime
        // pick would.
        const registry: RosettaMapRegistry = { '1.5.0': buildMap('1.5.0') };
        expect(() =>
            pickMapForVersion(registry, {
                version: '1.5.0-x',
                versionMatch: { versionRange: { min: '2.0.0+build', max: '1.0.0' } },
            }),
        ).toThrow(/versionRange\.min must be <= versionRange\.max/);
    });
});

describe('getMap guard (defensive)', () => {
    it('throws a clear error when a registry key maps to undefined', () => {
        // A malformed registry whose key has an explicitly-undefined value:
        // Object.keys still yields the key, so the code-range tier reaches
        // getMap, which fails loudly instead of crashing on `.version_code`.
        const reg = { broken: undefined } as unknown as RosettaMapRegistry;
        expect(() =>
            pickMapForVersion(reg, {
                version: 'x',
                versionMatch: { versionCodeRange: { min: 0 } },
            }),
        ).toThrow(/registry has no entry for key 'broken'/);
    });
});
