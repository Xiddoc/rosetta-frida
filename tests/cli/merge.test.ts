/**
 * Tests for `rosetta merge` (and the `merge-bundle` alias, which shares the
 * same `runMerge` implementation).
 */

import { describe, it, expect } from 'vitest';
import { parseMergeArgs, mergeMaps, mergeFiles, runMerge } from '../../cli/commands/merge.js';
import { MapValidationError, RosettaError } from '../../src/errors.js';
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

describe('parseMergeArgs', () => {
    it('parses N positionals + -o', () => {
        const o = parseMergeArgs(['a.json', 'b.json', 'c.json', '-o', 'out.json']);
        expect(o.inputPaths).toEqual(['a.json', 'b.json', 'c.json']);
        expect(o.outputPath).toBe('out.json');
        expect(o.force).toBe(false);
        expect(o.strict).toBe(false);
    });

    it('accepts --strict and --force', () => {
        const o = parseMergeArgs(['a.json', 'b.json', '-o', 'out.json', '--strict', '--force']);
        expect(o.strict).toBe(true);
        expect(o.force).toBe(true);
    });

    it('errors with fewer than two inputs', () => {
        expect(() => parseMergeArgs(['a.json', '-o', 'out.json'])).toThrow(/at least two/);
    });

    it('errors when -o is missing', () => {
        expect(() => parseMergeArgs(['a.json', 'b.json'])).toThrow(/requires -o/);
    });
});

describe('mergeMaps', () => {
    it('unions classes from two maps', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const b = baseMap({ classes: { 'com.x.B': { obfuscated: 'b' } } });
        const m = mergeMaps([a, b], false);
        expect(Object.keys(m.classes).sort()).toEqual(['com.x.A', 'com.x.B']);
    });

    it('concatenates sources from all inputs', () => {
        const a = baseMap({ sources: [{ tool: 'sigmatcher' }] });
        const b = baseMap({ sources: [{ tool: 'hand-authored' }] });
        const m = mergeMaps([a, b], false);
        expect(m.sources).toEqual([{ tool: 'sigmatcher' }, { tool: 'hand-authored' }]);
    });

    it('omits sources entirely when no input has any', () => {
        const m = mergeMaps([baseMap(), baseMap()], false);
        expect(m.sources).toBeUndefined();
    });

    it('last-wins for a class scalar field', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', dex: 'classes1.dex' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', dex: 'classes2.dex' } } });
        const m = mergeMaps([a, b], false);
        expect(m.classes['com.x.A']?.dex).toBe('classes2.dex');
    });

    it('last-wins for a conflicting obfuscated class name (non-strict)', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } });
        const m = mergeMaps([a, b], false);
        expect(m.classes['com.x.A']?.obfuscated).toBe('bbbb');
    });

    it('strict mode throws on a conflicting obfuscated class name', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } });
        expect(() => mergeMaps([a, b], true)).toThrow(/conflicting obfuscated name for class/);
    });

    it('strict mode allows an identical obfuscated class name', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa', dex: 'd' } } });
        const m = mergeMaps([a, b], true);
        expect(m.classes['com.x.A']?.dex).toBe('d');
    });

    it('merges method overloads, adding a new signature and last-winning a shared one', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'e', signature: '()V' }, // same sig → last-wins
                            { obfuscated: 'f', signature: '(I)V' }, // new sig → added
                        ],
                    },
                },
            },
        });
        const m = mergeMaps([a, b], false);
        const overloads = m.classes['com.x.A']?.methods?.m;
        expect(overloads).toEqual([
            { obfuscated: 'e', signature: '()V' },
            { obfuscated: 'f', signature: '(I)V' },
        ]);
    });

    it('strict mode throws on a conflicting overload obfuscated name', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'e', signature: '()V' }] },
                },
            },
        });
        expect(() => mergeMaps([a, b], true)).toThrow(/conflicting obfuscated name for method/);
    });

    it('takes the base methods when the next entry has none', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const m = mergeMaps([a, b], false);
        expect(m.classes['com.x.A']?.methods?.m).toHaveLength(1);
    });

    it('takes the next methods when the base entry has none', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const m = mergeMaps([a, b], false);
        expect(m.classes['com.x.A']?.methods?.m).toHaveLength(1);
    });

    it('adds a brand-new method real name on merge', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { n: [{ obfuscated: 'd', signature: '()V' }] },
                },
            },
        });
        const m = mergeMaps([a, b], false);
        expect(Object.keys(m.classes['com.x.A']?.methods ?? {}).sort()).toEqual(['m', 'n']);
    });

    it('merges fields last-wins and adds new ones', () => {
        const a = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    fields: {
                        f: { obfuscated: 'q', type: 'I' },
                        g: { obfuscated: 'r', type: 'I' },
                    },
                },
            },
        });
        const m = mergeMaps([a, b], false);
        expect(m.classes['com.x.A']?.fields?.f?.obfuscated).toBe('q');
        expect(m.classes['com.x.A']?.fields?.g?.obfuscated).toBe('r');
    });

    it('strict mode throws on a conflicting field obfuscated name', () => {
        const a = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'q', type: 'I' } } },
            },
        });
        expect(() => mergeMaps([a, b], true)).toThrow(/conflicting obfuscated name for field/);
    });

    it('takes base fields when next has none and vice versa', () => {
        const withF = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const without = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        expect(mergeMaps([withF, without], false).classes['com.x.A']?.fields?.f).toBeDefined();
        expect(mergeMaps([without, withF], false).classes['com.x.A']?.fields?.f).toBeDefined();
    });

    it('does not let an undefined optional on a later input erase an earlier value', () => {
        const a = baseMap({ captured_at: '2026-01-01' });
        const b = baseMap(); // captured_at undefined
        const m = mergeMaps([a, b], false);
        expect(m.captured_at).toBe('2026-01-01');
    });

    it('last-wins a defined top-level optional', () => {
        const a = baseMap({ version: '1.0.0' });
        const b = baseMap({ version: '1.0.1' });
        expect(mergeMaps([a, b], false).version).toBe('1.0.1');
    });

    it('rejects merging different apps', () => {
        const a = baseMap();
        const b = baseMap({ app: 'com.other.app' });
        expect(() => mergeMaps([a, b], false)).toThrow(/different apps/);
    });

    it('rejects merging different version_code', () => {
        const a = baseMap({ version_code: 100 });
        const b = baseMap({ version_code: 101 });
        expect(() => mergeMaps([a, b], false)).toThrow(/different version_code/);
    });
});

describe('mergeFiles', () => {
    const A = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } }));
    const B = JSON.stringify(baseMap({ classes: { 'com.x.B': { obfuscated: 'b' } } }));

    it('folds inputs and writes canonical JSON', async () => {
        const fake = makeFakeFs({ '/a.json': A, '/b.json': B });
        const out = await mergeFiles(['/a.json', '/b.json', '-o', '/out.json'], makeFsLike(fake));
        expect(out).toBe('/out.json');
        const written = fake.files.get('/out.json');
        expect(written).toContain('com.x.A');
        expect(written).toContain('com.x.B');
        expect(written?.endsWith('}\n')).toBe(true);
    });

    it('refuses to overwrite without --force', async () => {
        const fake = makeFakeFs({ '/a.json': A, '/b.json': B, '/out.json': 'old' });
        await expect(
            mergeFiles(['/a.json', '/b.json', '-o', '/out.json'], makeFsLike(fake)),
        ).rejects.toThrow(/refusing to overwrite/);
    });

    it('propagates a strict conflict from the fold', async () => {
        const a = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } }));
        const b = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } }));
        const fake = makeFakeFs({ '/a.json': a, '/b.json': b });
        await expect(
            mergeFiles(['/a.json', '/b.json', '-o', '/out.json', '--strict'], makeFsLike(fake)),
        ).rejects.toThrow(/conflicting obfuscated name/);
    });

    it('re-validates the fold and throws a MapValidationError when it overflows', async () => {
        // Each input is individually valid (<= MAX_METHOD_OVERLOADS = 200),
        // but their union for the same real method name exceeds the cap, so the
        // merged map fails schema re-validation before it is written. This is
        // the safety net the re-validate step exists for.
        const overloads = (start: number, count: number) =>
            Array.from({ length: count }, (_, i) => ({
                obfuscated: `m${start + i}`,
                signature: `(I${'I'.repeat(start + i)})V`, // unique per index
            }));
        const a = JSON.stringify(
            baseMap({
                classes: { 'com.x.A': { obfuscated: 'a', methods: { m: overloads(0, 150) } } },
            }),
        );
        const b = JSON.stringify(
            baseMap({
                classes: { 'com.x.A': { obfuscated: 'a', methods: { m: overloads(150, 150) } } },
            }),
        );
        const fake = makeFakeFs({ '/a.json': a, '/b.json': b });
        await expect(
            mergeFiles(['/a.json', '/b.json', '-o', '/out.json'], makeFsLike(fake)),
        ).rejects.toThrow(MapValidationError);
        // The bad fold is never written.
        expect(fake.files.has('/out.json')).toBe(false);
    });
});

describe('runMerge (command wrapper)', () => {
    const A = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } }));
    const B = JSON.stringify(baseMap({ classes: { 'com.x.B': { obfuscated: 'b' } } }));

    it('merges and returns the success message', async () => {
        const fake = makeFakeFs({ '/a.json': A, '/b.json': B });
        const msg = await runMerge(
            ['/a.json', '/b.json', '-o', '/out.json'],
            makeIo(fake, makeCaptured()),
        );
        expect(msg).toBe('wrote /out.json');
        expect(fake.files.has('/out.json')).toBe(true);
    });

    it('propagates a RosettaError instead of catching', async () => {
        const fake = makeFakeFs({ '/a.json': A });
        await expect(
            runMerge(['/a.json', '/b.json', '-o', '/out.json'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow(RosettaError);
    });
});
