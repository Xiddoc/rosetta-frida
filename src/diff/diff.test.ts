/**
 * Tests for the pure map-diff engine (`src/diff/`). The CLI-contract tests
 * (arg-parse / IO / exit code) live in `tests/cli/diff.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { diffMaps, renderHumanDiff, type MapDiff } from './diff.js';
import type { RosettaMap } from '../types/map.js';

/** A minimal valid in-memory map for direct diffMaps tests. */
function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 3,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: {},
        ...overrides,
    };
}

describe('diffMaps', () => {
    it('reports identical maps as no change', () => {
        const m = baseMap({ classes: { 'com.x.Foo': { obfuscated: 'a' } } });
        const d = diffMaps(m, m);
        expect(d.classesAdded).toEqual([]);
        expect(d.classesRemoved).toEqual([]);
        expect(d.classesChanged).toEqual([]);
    });

    it('asserts app-equality so a direct caller cannot mislabel the diff', () => {
        const a = baseMap();
        const b = baseMap({ app: 'com.other.app' });
        expect(() => diffMaps(a, b)).toThrow(/different apps/);
    });

    it('carries both version labels through to the diff', () => {
        const from = baseMap({ version: '1.0.0' });
        const to = baseMap({ version: '1.0.1', version_code: 101 });
        const d = diffMaps(from, to);
        expect(d.fromVersion).toBe('1.0.0');
        expect(d.toVersion).toBe('1.0.1');
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

    it('pairs a 2-overload method: one pure rename + one positional resign+rename', () => {
        // Overload #1 keeps signature `()V` → paired by signature, pure rename
        // (c -> e). Overload #2's signature rotates `(Laaaa;)V` -> `(Lbbbb;)V`
        // so it falls through to the positional pass and is BOTH a re-sign and
        // a rename (d -> f). This pins the two-pass pairing behaviour.
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'c', signature: '()V' },
                            { obfuscated: 'd', signature: '(Laaaa;)V' },
                        ],
                    },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'e', signature: '()V' },
                            { obfuscated: 'f', signature: '(Lbbbb;)V' },
                        ],
                    },
                },
            },
        });
        const delta = diffMaps(from, to).classesChanged[0];
        // Both the signature-matched rename and the positional rename are present.
        expect(delta?.methodsRenamed).toEqual([
            { name: 'm', from: 'c', to: 'e' },
            { name: 'm', from: 'd', to: 'f' },
        ]);
        expect(delta?.methodsResigned).toEqual([{ name: 'm', from: '(Laaaa;)V', to: '(Lbbbb;)V' }]);
    });

    it('pairs two overloads both kept by signature (no spurious resign)', () => {
        const from = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'c', signature: '()V' },
                            { obfuscated: 'd', signature: '(I)V' },
                        ],
                    },
                },
            },
        });
        const to = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'x', signature: '()V' },
                            { obfuscated: 'y', signature: '(I)V' },
                        ],
                    },
                },
            },
        });
        const delta = diffMaps(from, to).classesChanged[0];
        expect(delta?.methodsResigned).toEqual([]);
        expect(delta?.methodsRenamed).toEqual([
            { name: 'm', from: 'c', to: 'x' },
            { name: 'm', from: 'd', to: 'y' },
        ]);
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

    it('includes both version labels in the header when present', () => {
        const d: MapDiff = {
            app: 'com.example.app',
            fromVersionCode: 100,
            toVersionCode: 101,
            fromVersion: '1.0.0',
            toVersion: '1.0.1',
            classesAdded: [],
            classesRemoved: [],
            classesChanged: [],
        };
        expect(renderHumanDiff(d)).toContain('com.example.app: 100 (1.0.0) -> 101 (1.0.1)');
    });

    it('falls back to bare version codes when no version label is present', () => {
        const d: MapDiff = {
            app: 'com.example.app',
            fromVersionCode: 100,
            toVersionCode: 101,
            classesAdded: [],
            classesRemoved: [],
            classesChanged: [],
        };
        expect(renderHumanDiff(d)).toContain('com.example.app: 100 -> 101');
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
