/**
 * CLI-contract tests for `rosetta merge` — arg-parse, IO, the re-validate
 * step, the stderr override notice, and --force. The pure fold engine is
 * tested in `src/merge/`.
 */

import { describe, it, expect } from 'vitest';
import { parseMergeArgs, mergeFiles, runMerge } from '../../cli/commands/merge.js';
import { MapValidationError, RosettaError } from '../../src/errors.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo } from './helpers.js';

function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 4,
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

    it('folds three inputs last-wins through the file path', async () => {
        const a = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'a1' } } }));
        const b = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'a2' } } }));
        const c = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'a3' } } }));
        const fake = makeFakeFs({ '/a.json': a, '/b.json': b, '/c.json': c });
        await mergeFiles(['/a.json', '/b.json', '/c.json', '-o', '/out.json'], makeFsLike(fake));
        const written = JSON.parse(fake.files.get('/out.json') as string) as RosettaMap;
        expect(written.classes['com.x.A']?.obfuscated).toBe('a3');
    });

    it('refuses to overwrite without --force', async () => {
        const fake = makeFakeFs({ '/a.json': A, '/b.json': B, '/out.json': 'old' });
        await expect(
            mergeFiles(['/a.json', '/b.json', '-o', '/out.json'], makeFsLike(fake)),
        ).rejects.toThrow(/refusing to overwrite/);
    });

    it('overwrites with --force', async () => {
        const fake = makeFakeFs({ '/a.json': A, '/b.json': B, '/out.json': 'old' });
        const out = await mergeFiles(
            ['/a.json', '/b.json', '-o', '/out.json', '--force'],
            makeFsLike(fake),
        );
        expect(out).toBe('/out.json');
        expect(fake.files.get('/out.json')).toContain('com.x.A');
    });

    it('emits a stderr notice on each non-strict obfuscated-name override', async () => {
        const a = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } }));
        const b = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } }));
        const fake = makeFakeFs({ '/a.json': a, '/b.json': b });
        const notices: string[] = [];
        await mergeFiles(['/a.json', '/b.json', '-o', '/out.json'], makeFsLike(fake), (l) =>
            notices.push(l),
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatch(/class 'com\.x\.A' obfuscated name overridden 'aaaa' -> 'bbbb'/);
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
        // merged map fails schema re-validation before it is written.
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

    it('routes the override notice to io.stderr', async () => {
        const a = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } }));
        const b = JSON.stringify(baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } }));
        const fake = makeFakeFs({ '/a.json': a, '/b.json': b });
        const captured = makeCaptured();
        await runMerge(['/a.json', '/b.json', '-o', '/out.json'], makeIo(fake, captured));
        expect(captured.stderr.some((l) => /obfuscated name overridden/.test(l))).toBe(true);
    });

    it('propagates a RosettaError instead of catching', async () => {
        const fake = makeFakeFs({ '/a.json': A });
        await expect(
            runMerge(['/a.json', '/b.json', '-o', '/out.json'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow(RosettaError);
    });
});
