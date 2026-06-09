/**
 * Unit tests for the map-freshness core (`src/freshness/freshness.ts`) — the
 * read-only consumer twin of the maps-side `check_map_freshness.py` CI check.
 *
 * These pin the SHARED algorithm in BOTH directions (the same way the Python
 * check's `--self-test` does), since the contract is cross-repo:
 *   - a map MISSING a ruled class is flagged stale, with the exact missing FQN;
 *   - a map containing EVERY ruled class (even a superset) is NOT flagged;
 *   - the `$`-nested rule name maps verbatim to the map-key FQN;
 *   - an app with no signatures sets no expectation;
 *   - malformed inputs (bad YAML / JSON / wrong shape) throw — staleness never
 *     does.
 */

import { describe, it, expect } from 'vitest';
import {
    analyse,
    ruleFqns,
    parseSignatures,
    mapClassKeys,
    parseMapClassKeys,
    renderReport,
    FreshnessInputError,
    type MapClassKeys,
} from './freshness.js';

const SIGS_FRESH = `
- name: 'IRemoteService$Stub'
  package: 'com.example.app'
  signatures:
      - signature: '"com.example.app.IRemoteService"'
        type: regex
- name: 'Config'
  package: 'com.example.app'
  signatures:
      - signature: '"https://x.example/api"'
        type: regex
`;

const EXPECTED = new Set(['com.example.app.IRemoteService$Stub', 'com.example.app.Config']);

function mapEntry(mapPath: string, app: string, versionCode: string, keys: string[]): MapClassKeys {
    return { mapPath, app, versionCode, classKeys: new Set(keys) };
}

describe('ruleFqns', () => {
    it('maps a `$`-nested rule name verbatim to the map-key FQN', () => {
        const doc = parseSignatures(SIGS_FRESH, '<fixture>');
        expect(doc).toEqual(EXPECTED);
    });

    it('uses <package>.<name> for a non-nested rule', () => {
        const fqns = ruleFqns([{ name: 'Config', package: 'com.example.app' }], '<f>');
        expect([...fqns]).toEqual(['com.example.app.Config']);
    });

    it('dedupes repeated rules into a set', () => {
        const fqns = ruleFqns(
            [
                { name: 'A', package: 'com.x' },
                { name: 'A', package: 'com.x' },
            ],
            '<f>',
        );
        expect(fqns.size).toBe(1);
    });

    it('throws on a non-list document', () => {
        expect(() => ruleFqns('not a list', '<f>')).toThrow(FreshnessInputError);
        expect(() => ruleFqns('not a list', '<f>')).toThrow(/non-empty list/);
    });

    it('throws on an empty list', () => {
        expect(() => ruleFqns([], '<f>')).toThrow(/non-empty list/);
    });

    it('throws when a rule is not a mapping', () => {
        expect(() => ruleFqns(['nope'], '<f>')).toThrow(/rule\[0\] must be a mapping/);
        expect(() => ruleFqns([['arr']], '<f>')).toThrow(/rule\[0\] must be a mapping/);
        expect(() => ruleFqns([null], '<f>')).toThrow(/rule\[0\] must be a mapping/);
    });

    it('throws when name is missing or blank', () => {
        expect(() => ruleFqns([{ package: 'com.x' }], '<f>')).toThrow(/missing.*'name'/);
        expect(() => ruleFqns([{ name: '  ', package: 'com.x' }], '<f>')).toThrow(/'name'/);
        expect(() => ruleFqns([{ name: 7, package: 'com.x' }], '<f>')).toThrow(/'name'/);
    });

    it('throws when package is missing or blank', () => {
        expect(() => ruleFqns([{ name: 'A' }], '<f>')).toThrow(/missing.*'package'/);
        expect(() => ruleFqns([{ name: 'A', package: '' }], '<f>')).toThrow(/'package'/);
        expect(() => ruleFqns([{ name: 'A', package: 3 }], '<f>')).toThrow(/'package'/);
    });
});

describe('parseSignatures', () => {
    it('parses valid YAML to the expected-FQN set', () => {
        expect(parseSignatures(SIGS_FRESH, 'sig.yaml')).toEqual(EXPECTED);
    });

    it('throws a FreshnessInputError on a YAML syntax error', () => {
        // Unclosed flow mapping is a YAML parse error.
        expect(() => parseSignatures('- name: {', 'sig.yaml')).toThrow(FreshnessInputError);
        expect(() => parseSignatures('- name: {', 'sig.yaml')).toThrow(/could not parse YAML/);
    });
});

describe('mapClassKeys', () => {
    it('returns the classes object keys as a set', () => {
        const keys = mapClassKeys({ classes: { 'com.x.A': {}, 'com.x.B': {} } }, '<m>');
        expect(keys).toEqual(new Set(['com.x.A', 'com.x.B']));
    });

    it('throws when the map is not an object', () => {
        expect(() => mapClassKeys('nope', '<m>')).toThrow(/not a JSON object/);
        expect(() => mapClassKeys(['arr'], '<m>')).toThrow(/not a JSON object/);
        expect(() => mapClassKeys(null, '<m>')).toThrow(/not a JSON object/);
    });

    it("throws when 'classes' is not an object", () => {
        expect(() => mapClassKeys({ classes: 'nope' }, '<m>')).toThrow(
            /'classes' is not an object/,
        );
        expect(() => mapClassKeys({ classes: ['a'] }, '<m>')).toThrow(/'classes' is not an object/);
        expect(() => mapClassKeys({}, '<m>')).toThrow(/'classes' is not an object/);
    });
});

describe('parseMapClassKeys', () => {
    it('parses valid JSON to the classes key set', () => {
        const keys = parseMapClassKeys('{"classes":{"com.x.A":{}}}', '30405.json');
        expect(keys).toEqual(new Set(['com.x.A']));
    });

    it('throws a FreshnessInputError on a JSON syntax error', () => {
        expect(() => parseMapClassKeys('{ not json', '30405.json')).toThrow(FreshnessInputError);
        expect(() => parseMapClassKeys('{ not json', '30405.json')).toThrow(/could not parse JSON/);
    });
});

describe('analyse', () => {
    const sigByApp = new Map([['com.example.app', EXPECTED]]);

    it('flags a map missing a ruled class, naming the exact missing FQN', () => {
        const maps = [
            mapEntry('maps/com.example.app/30404.json', 'com.example.app', '30404', [
                'com.example.app.IRemoteService$Stub',
            ]),
        ];
        const report = analyse(maps, sigByApp);
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0]?.missing).toEqual(['com.example.app.Config']);
        expect(report.findings[0]?.app).toBe('com.example.app');
        expect(report.findings[0]?.versionCode).toBe('30404');
        expect(report.mapsChecked).toBe(1);
        expect(report.appsWithSignatures).toBe(1);
    });

    it('does NOT flag a map containing every ruled class (superset is fine)', () => {
        const maps = [
            mapEntry('maps/com.example.app/30405.json', 'com.example.app', '30405', [
                'com.example.app.IRemoteService$Stub',
                'com.example.app.Config',
                'com.example.app.SomethingExtra',
            ]),
        ];
        const report = analyse(maps, sigByApp);
        expect(report.findings).toHaveLength(0);
    });

    it('reports multiple missing FQNs sorted', () => {
        const maps = [mapEntry('maps/com.example.app/1.json', 'com.example.app', '1', [])];
        const report = analyse(maps, sigByApp);
        expect(report.findings[0]?.missing).toEqual([
            'com.example.app.Config',
            'com.example.app.IRemoteService$Stub',
        ]);
    });

    it('does not analyse a map for an app with no signatures', () => {
        const maps = [mapEntry('maps/com.other.app/1.json', 'com.other.app', '1', [])];
        const report = analyse(maps, sigByApp);
        expect(report.findings).toHaveLength(0);
        expect(report.mapsChecked).toBe(1);
    });

    it('treats an empty expectation set as no expectation', () => {
        const maps = [mapEntry('maps/com.empty/1.json', 'com.empty', '1', [])];
        const report = analyse(maps, new Map([['com.empty', new Set<string>()]]));
        expect(report.findings).toHaveLength(0);
        // The app still counts as having a (empty) signatures source.
        expect(report.appsWithSignatures).toBe(1);
    });

    it('sorts findings by mapPath regardless of input order', () => {
        // Supply out-of-order paths so BOTH comparator branches are exercised.
        const maps = [
            mapEntry('maps/com.example.app/30500.json', 'com.example.app', '30500', []),
            mapEntry('maps/com.example.app/30404.json', 'com.example.app', '30404', []),
        ];
        const report = analyse(maps, sigByApp);
        expect(report.findings.map((f) => f.versionCode)).toEqual(['30404', '30500']);
    });
});

describe('renderReport', () => {
    it('renders a reassuring single line when all maps are fresh', () => {
        const out = renderReport({ findings: [], mapsChecked: 3, appsWithSignatures: 1 });
        expect(out).toBe(
            'all 3 map(s) fresh against the current signatures (1 app(s) with signatures)',
        );
    });

    it('lists each stale map and its missing rules', () => {
        const out = renderReport({
            findings: [
                {
                    mapPath: 'maps/com.example.app/30404.json',
                    app: 'com.example.app',
                    versionCode: '30404',
                    missing: ['com.example.app.Config', 'com.example.app.Widget'],
                },
            ],
            mapsChecked: 2,
            appsWithSignatures: 1,
        });
        expect(out).toContain('1 stale map(s) of 2 checked');
        expect(out).toContain(
            'maps/com.example.app/30404.json (com.example.app@30404) — missing 2:',
        );
        expect(out).toContain('    com.example.app.Config');
        expect(out).toContain('    com.example.app.Widget');
    });
});
