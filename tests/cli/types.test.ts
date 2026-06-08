/**
 * Tests for `rosetta types`.
 */

import { describe, it, expect } from 'vitest';
import {
    parseTypesArgs,
    collectNames,
    renderTypes,
    typesFile,
    runTypes,
} from '../../cli/commands/types.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo } from './helpers.js';

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

describe('parseTypesArgs', () => {
    it('parses positional + -o', () => {
        const o = parseTypesArgs(['m.json', '-o', 'out.d.ts']);
        expect(o.inputPath).toBe('m.json');
        expect(o.outputPath).toBe('out.d.ts');
        expect(o.force).toBe(false);
    });

    it('accepts --force', () => {
        expect(parseTypesArgs(['m.json', '-o', 'out.d.ts', '-f']).force).toBe(true);
    });

    it('errors on wrong positional count', () => {
        expect(() => parseTypesArgs(['-o', 'out.d.ts'])).toThrow(/exactly one/);
    });

    it('errors when -o is missing', () => {
        expect(() => parseTypesArgs(['m.json'])).toThrow(/requires -o/);
    });
});

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
    it('emits unions for classes, methods, and fields', () => {
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
        expect(dts).toContain("export type RosettaClassName = 'com.x.Foo';");
        expect(dts).toContain("export type RosettaMethodName = 'com.x.Foo.doThing';");
        expect(dts).toContain("export type RosettaFieldName = 'com.x.Foo.count';");
        expect(dts).toContain('"com.x.Foo": {');
        expect(dts).toContain("methods: 'doThing';");
        expect(dts).toContain("fields: 'count';");
        // Provenance / determinism markers.
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
        expect(renderTypes(m)).toContain("export type RosettaClassName = 'com.x.A' | 'com.x.B';");
    });

    it('is deterministic for the same input', () => {
        const m = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        expect(renderTypes(m)).toBe(renderTypes(m));
    });
});

describe('typesFile', () => {
    const MAP = JSON.stringify(
        baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        }),
    );

    it('writes the .d.ts and returns the path', async () => {
        const fake = makeFakeFs({ '/m.json': MAP });
        const out = await typesFile(['/m.json', '-o', '/out.d.ts'], makeFsLike(fake));
        expect(out).toBe('/out.d.ts');
        expect(fake.files.get('/out.d.ts')).toContain('RosettaClassName');
    });

    it('refuses to overwrite without --force', async () => {
        const fake = makeFakeFs({ '/m.json': MAP, '/out.d.ts': 'old' });
        await expect(typesFile(['/m.json', '-o', '/out.d.ts'], makeFsLike(fake))).rejects.toThrow(
            /refusing to overwrite/,
        );
    });

    it('overwrites with --force', async () => {
        const fake = makeFakeFs({ '/m.json': MAP, '/out.d.ts': 'old' });
        await typesFile(['/m.json', '-o', '/out.d.ts', '--force'], makeFsLike(fake));
        expect(fake.files.get('/out.d.ts')).toContain('RosettaClassName');
    });
});

describe('runTypes (command wrapper)', () => {
    it('returns the success message', async () => {
        const fake = makeFakeFs({
            '/m.json': JSON.stringify(baseMap({ classes: { 'com.x.Foo': { obfuscated: 'a' } } })),
        });
        const msg = await runTypes(['/m.json', '-o', '/out.d.ts'], makeIo(fake, makeCaptured()));
        expect(msg).toBe('wrote /out.d.ts');
    });

    it('propagates a load error', async () => {
        const fake = makeFakeFs({});
        await expect(
            runTypes(['/missing.json', '-o', '/out.d.ts'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow();
    });
});
