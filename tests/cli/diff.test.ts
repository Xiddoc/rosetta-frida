/**
 * Tests for `rosetta diff`.
 */

import { describe, it, expect } from 'vitest';
import {
    parseDiffArgs,
    diffMaps,
    renderHumanDiff,
    runDiff,
    type MapDiff,
} from '../../cli/commands/diff.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

/** A minimal valid in-memory map for direct diffMaps tests. */
function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 2,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: {},
        ...overrides,
    };
}

describe('parseDiffArgs', () => {
    it('parses two positionals', () => {
        const o = parseDiffArgs(['a.json', 'b.json']);
        expect(o.fromPath).toBe('a.json');
        expect(o.toPath).toBe('b.json');
        expect(o.json).toBe(false);
    });

    it('accepts --json', () => {
        expect(parseDiffArgs(['a.json', 'b.json', '--json']).json).toBe(true);
    });

    it('errors on too few positionals', () => {
        expect(() => parseDiffArgs(['a.json'])).toThrow(/exactly two/);
    });

    it('errors on too many positionals', () => {
        expect(() => parseDiffArgs(['a.json', 'b.json', 'c.json'])).toThrow(/exactly two/);
    });

    it('errors on unknown option', () => {
        expect(() => parseDiffArgs(['a.json', 'b.json', '--bogus'])).toThrow(/unknown option/);
    });
});

describe('diffMaps', () => {
    it('reports identical maps as no change', () => {
        const m = baseMap({ classes: { 'com.x.Foo': { obfuscated: 'a' } } });
        const d = diffMaps(m, m);
        expect(d.classesAdded).toEqual([]);
        expect(d.classesRemoved).toEqual([]);
        expect(d.classesChanged).toEqual([]);
    });

    it('detects an added and a removed class', () => {
        const from = baseMap({ classes: { 'com.x.Old': { obfuscated: 'a' } } });
        const to = baseMap({
            version_code: 101,
            classes: { 'com.x.New': { obfuscated: 'b' } },
        });
        const d = diffMaps(from, to);
        expect(d.classesAdded).toEqual(['com.x.New']);
        expect(d.classesRemoved).toEqual(['com.x.Old']);
        expect(d.fromVersionCode).toBe(100);
        expect(d.toVersionCode).toBe(101);
    });

    it('detects a class obfuscated-name rotation', () => {
        const from = baseMap({ classes: { 'com.x.Foo': { obfuscated: 'aaaa' } } });
        const to = baseMap({ classes: { 'com.x.Foo': { obfuscated: 'zzzz' } } });
        const d = diffMaps(from, to);
        expect(d.classesChanged).toHaveLength(1);
        expect(d.classesChanged[0]?.obfuscated).toEqual({
            name: 'com.x.Foo',
            from: 'aaaa',
            to: 'zzzz',
        });
    });

    it('detects a method obfuscated rename (matched by signature)', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'e', signature: '()V' }] },
                },
            },
        });
        const d = diffMaps(from, to);
        expect(d.classesChanged[0]?.methodsRenamed).toEqual([{ name: 'm', from: 'c', to: 'e' }]);
        expect(d.classesChanged[0]?.methodsResigned).toEqual([]);
    });

    it('detects a method signature re-sign (matched positionally)', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '(Laaaa;)V' }] },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '(Lbbbb;)V' }] },
                },
            },
        });
        const d = diffMaps(from, to);
        expect(d.classesChanged[0]?.methodsResigned).toEqual([
            { name: 'm', from: '(Laaaa;)V', to: '(Lbbbb;)V' },
        ]);
    });

    it('detects both a re-sign and a rename on the same positional pairing', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '(I)V' }] },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'e', signature: '(J)V' }] },
                },
            },
        });
        const d = diffMaps(from, to);
        expect(d.classesChanged[0]?.methodsResigned).toHaveLength(1);
        expect(d.classesChanged[0]?.methodsRenamed).toEqual([{ name: 'm', from: 'c', to: 'e' }]);
    });

    it('detects added and removed methods', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { gone: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { fresh: [{ obfuscated: 'd', signature: '()V' }] },
                },
            },
        });
        const d = diffMaps(from, to);
        expect(d.classesChanged[0]?.methodsAdded).toEqual(['fresh']);
        expect(d.classesChanged[0]?.methodsRemoved).toEqual(['gone']);
    });

    it('detects field rename, add, and remove', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    fields: {
                        kept: { obfuscated: 'p', type: 'I' },
                        gone: { obfuscated: 'q', type: 'I' },
                    },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    fields: {
                        kept: { obfuscated: 'r', type: 'I' },
                        fresh: { obfuscated: 's', type: 'I' },
                    },
                },
            },
        });
        const d = diffMaps(from, to);
        const delta = d.classesChanged[0];
        expect(delta?.fieldsRenamed).toEqual([{ name: 'kept', from: 'p', to: 'r' }]);
        expect(delta?.fieldsAdded).toEqual(['fresh']);
        expect(delta?.fieldsRemoved).toEqual(['gone']);
    });

    it('omits a class whose entry is unchanged from classesChanged', () => {
        const cls = {
            'com.x.Same': {
                obfuscated: 'a',
                methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
            },
        };
        const d = diffMaps(baseMap({ classes: cls }), baseMap({ classes: cls }));
        expect(d.classesChanged).toEqual([]);
    });
});

describe('renderHumanDiff', () => {
    it('renders the no-change report', () => {
        const d: MapDiff = {
            app: 'com.example.app',
            fromVersionCode: 100,
            toVersionCode: 100,
            classesAdded: [],
            classesRemoved: [],
            classesChanged: [],
        };
        expect(renderHumanDiff(d)).toBe('com.example.app: 100 -> 100\n  no structural changes');
    });

    it('renders adds, removes, and a full class delta', () => {
        const d: MapDiff = {
            app: 'com.example.app',
            fromVersionCode: 100,
            toVersionCode: 101,
            classesAdded: ['com.x.New'],
            classesRemoved: ['com.x.Old'],
            classesChanged: [
                {
                    name: 'com.x.Foo',
                    obfuscated: { name: 'com.x.Foo', from: 'aaaa', to: 'zzzz' },
                    methodsAdded: ['fresh'],
                    methodsRemoved: ['gone'],
                    methodsRenamed: [{ name: 'm', from: 'c', to: 'e' }],
                    methodsResigned: [{ name: 'n', from: '(I)V', to: '(J)V' }],
                    fieldsAdded: ['nf'],
                    fieldsRemoved: ['of'],
                    fieldsRenamed: [{ name: 'f', from: 'p', to: 'r' }],
                },
            ],
        };
        const text = renderHumanDiff(d);
        expect(text).toContain('+ class com.x.New');
        expect(text).toContain('- class com.x.Old');
        expect(text).toContain('~ com.x.Foo (obfuscated aaaa -> zzzz)');
        expect(text).toContain('method m: obfuscated c -> e');
        expect(text).toContain('method n: signature (I)V -> (J)V');
        expect(text).toContain('+ method fresh');
        expect(text).toContain('- method gone');
        expect(text).toContain('field f: obfuscated p -> r');
        expect(text).toContain('+ field nf');
        expect(text).toContain('- field of');
    });

    it('renders a class delta header without obfuscated change', () => {
        const d: MapDiff = {
            app: 'com.example.app',
            fromVersionCode: 100,
            toVersionCode: 101,
            classesAdded: [],
            classesRemoved: [],
            classesChanged: [
                {
                    name: 'com.x.Foo',
                    methodsAdded: ['m'],
                    methodsRemoved: [],
                    methodsRenamed: [],
                    methodsResigned: [],
                    fieldsAdded: [],
                    fieldsRemoved: [],
                    fieldsRenamed: [],
                },
            ],
        };
        const text = renderHumanDiff(d);
        expect(text).toContain('  ~ com.x.Foo\n');
        expect(text).not.toContain('obfuscated');
    });
});

const MAP_A = JSON.stringify(baseMap({ classes: { 'com.x.Foo': { obfuscated: 'aaaa' } } }));
const MAP_B = JSON.stringify(
    baseMap({ version_code: 101, classes: { 'com.x.Foo': { obfuscated: 'zzzz' } } }),
);

describe('runDiff (command wrapper)', () => {
    it('returns the human report by default', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': MAP_B });
        const msg = await runDiff(['/a.json', '/b.json'], makeIo(fs, makeCaptured()));
        expect(msg).toContain('com.example.app: 100 -> 101');
        expect(msg).toContain('obfuscated aaaa -> zzzz');
    });

    it('returns JSON with --json', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': MAP_B });
        const msg = await runDiff(['/a.json', '/b.json', '--json'], makeIo(fs, makeCaptured()));
        const parsed = JSON.parse(msg) as MapDiff;
        expect(parsed.toVersionCode).toBe(101);
        expect(parsed.classesChanged).toHaveLength(1);
    });

    it('rejects diffing maps for different apps', async () => {
        const other = JSON.stringify(baseMap({ app: 'com.other.app' }));
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': other });
        await expect(runDiff(['/a.json', '/b.json'], makeIo(fs, makeCaptured()))).rejects.toThrow(
            /different apps/,
        );
    });

    it('propagates a load/validation error from a malformed input', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': '{ not valid' });
        await expect(runDiff(['/a.json', '/b.json'], makeIo(fs, makeCaptured()))).rejects.toThrow();
    });
});
