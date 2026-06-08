/**
 * Tests for the pure `.d.ts` renderer (`src/types-emit/`). The CLI-contract
 * tests (arg-parse / IO / write) live in `tests/cli/types.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { collectNames, renderTypes } from './emit.js';
import type { RosettaMap } from '../types/map.js';

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

describe('collectNames', () => {
    it('returns sorted class names with sorted methods and fields', () => {
        const m = baseMap({
            classes: {
                'com.x.B': { obfuscated: 'b' },
                'com.x.A': {
                    obfuscated: 'a',
                    methods: {
                        z: [{ obfuscated: 'c', signature: '()V' }],
                        a: [{ obfuscated: 'd', signature: '()V' }],
                    },
                    fields: {
                        y: { obfuscated: 'p', type: 'I' },
                        b: { obfuscated: 'q', type: 'I' },
                    },
                },
            },
        });
        const names = collectNames(m);
        expect(names.map((n) => n.className)).toEqual(['com.x.A', 'com.x.B']);
        expect(names[0]?.methods).toEqual(['a', 'z']);
        expect(names[0]?.fields).toEqual(['b', 'y']);
        expect(names[1]?.methods).toEqual([]);
    });
});

describe('renderTypes', () => {
    it('emits unions for classes, methods, and fields (double-quoted literals)', () => {
        const m = baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { doThing: [{ obfuscated: 'c', signature: '()V' }] },
                    fields: { count: { obfuscated: 'p', type: 'I' } },
                },
            },
        });
        const dts = renderTypes(m);
        expect(dts).toContain('export type RosettaClassName = "com.x.Foo";');
        expect(dts).toContain('export type RosettaMethodName = "com.x.Foo.doThing";');
        expect(dts).toContain('export type RosettaFieldName = "com.x.Foo.count";');
        expect(dts).toContain('"com.x.Foo": {');
        expect(dts).toContain('methods: "doThing";');
        expect(dts).toContain('fields: "count";');
        expect(dts).toContain('com.example.app@1.0.0');
        expect(dts).toContain('version_code 100');
        expect(dts.endsWith('\n')).toBe(true);
    });

    it('uses `never` for empty method/field/class unions', () => {
        const empty = renderTypes(baseMap());
        expect(empty).toContain('export type RosettaClassName = never;');
        expect(empty).toContain('export type RosettaMethodName = never;');
        expect(empty).toContain('export type RosettaFieldName = never;');

        const noMembers = renderTypes(baseMap({ classes: { 'com.x.Foo': { obfuscated: 'a' } } }));
        expect(noMembers).toContain('methods: never;');
        expect(noMembers).toContain('fields: never;');
    });

    it('joins multiple names with a pipe', () => {
        const m = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a' },
                'com.x.B': { obfuscated: 'b' },
            },
        });
        expect(renderTypes(m)).toContain('export type RosettaClassName = "com.x.A" | "com.x.B";');
    });

    it('escapes a class/method/field name containing a quote and a backslash', () => {
        // Schema-legal `classes` keys: a name with a single quote and a
        // backslash. Single-quoting raw produced invalid TS; JSON.stringify
        // double-quotes and escapes both so the emitted union parses.
        const tricky = "com.x.O'Brien\\Weird";
        const m = baseMap({
            classes: {
                [tricky]: {
                    obfuscated: 'a',
                    methods: { "m'eth\\od": [{ obfuscated: 'c', signature: '()V' }] },
                    fields: { "f'ield\\x": { obfuscated: 'p', type: 'I' } },
                },
            },
        });
        const dts = renderTypes(m);
        // JSON.stringify renders the quote unescaped (double-quoted context) and
        // the backslash as `\\`. The emitted literal must contain exactly that.
        const expectedClass = JSON.stringify(tricky);
        expect(dts).toContain(`export type RosettaClassName = ${expectedClass};`);
        expect(dts).toContain(`${expectedClass}: {`);
        expect(dts).toContain(JSON.stringify(`${tricky}.m'eth\\od`));
        expect(dts).toContain(JSON.stringify(`${tricky}.f'ield\\x`));
        // No raw single-quoted literal leaked through.
        expect(dts).not.toContain("'com.x.O'Brien");
    });

    it('sanitizes a comment-terminator in `version` so the header stays a valid comment', () => {
        // A schema-legal version that carries the block-comment terminator must
        // not break out of the generated JSDoc header.
        const m = baseMap({ version: '1.0*/x' });
        const dts = renderTypes(m);
        // The raw terminator does not appear inside the header (it was split).
        const header = dts.slice(0, dts.indexOf('export type'));
        expect(header).not.toContain('*/x');
        expect(header).toContain('* /x');
        // And the body that follows the header is intact, parseable output.
        expect(dts).toContain('export type RosettaClassName =');
    });

    it('sanitizes a comment-terminator in `app` too', () => {
        const m = baseMap({ app: 'com.x*/evil' });
        const header = renderTypes(m);
        const headerOnly = header.slice(0, header.indexOf('export type'));
        expect(headerOnly).not.toContain('x*/evil');
        expect(headerOnly).toContain('x* /evil');
    });

    it('is deterministic for the same input', () => {
        const m = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        expect(renderTypes(m)).toBe(renderTypes(m));
    });
});
