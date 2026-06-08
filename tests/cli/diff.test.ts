/**
 * CLI-contract tests for `rosetta diff` — arg-parse, IO, and the
 * `--exit-code` drift gate. The pure diff engine is tested in `src/diff/`.
 */

import { describe, it, expect } from 'vitest';
import { parseDiffArgs, runDiff, type MapDiff } from '../../cli/commands/diff.js';
import { route, EXIT_OK, EXIT_FAILURE } from '../../cli/router.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

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
        expect(o.exitCode).toBe(false);
    });

    it('accepts --json', () => {
        expect(parseDiffArgs(['a.json', 'b.json', '--json']).json).toBe(true);
    });

    it('accepts --exit-code', () => {
        expect(parseDiffArgs(['a.json', 'b.json', '--exit-code']).exitCode).toBe(true);
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

const MAP_A = JSON.stringify(baseMap({ classes: { 'com.x.Foo': { obfuscated: 'aaaa' } } }));
const MAP_B = JSON.stringify(
    baseMap({ version_code: 101, classes: { 'com.x.Foo': { obfuscated: 'zzzz' } } }),
);

describe('runDiff (command wrapper)', () => {
    it('returns the human report by default', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': MAP_B });
        const msg = await runDiff(['/a.json', '/b.json'], makeIo(fs, makeCaptured()));
        expect(msg).toContain('com.example.app: 100');
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

    it('--exit-code returns the report normally when the diff is empty', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': MAP_A });
        const msg = await runDiff(
            ['/a.json', '/b.json', '--exit-code'],
            makeIo(fs, makeCaptured()),
        );
        expect(msg).toContain('no structural changes');
    });

    it('--exit-code throws a DiffDriftError carrying the report on a non-empty diff', async () => {
        const fs = makeFakeFs({ '/a.json': MAP_A, '/b.json': MAP_B });
        await expect(
            runDiff(['/a.json', '/b.json', '--exit-code'], makeIo(fs, makeCaptured())),
        ).rejects.toThrow(/non-empty/);
    });
});

describe('diff --exit-code through the router', () => {
    it('exits 0 with the report on stdout when the diff is empty', async () => {
        const fs = makeFakeFs({ 'a.json': MAP_A, 'b.json': MAP_A });
        const captured = makeCaptured();
        const code = await route(['diff', 'a.json', 'b.json', '--exit-code'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toContain('no structural changes');
        expect(captured.stderr).toEqual([]);
    });

    it('exits 1 with the report on STDOUT (not stderr) on a non-empty diff', async () => {
        const fs = makeFakeFs({ 'a.json': MAP_A, 'b.json': MAP_B });
        const captured = makeCaptured();
        const code = await route(['diff', 'a.json', 'b.json', '--exit-code'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        // The drift report goes to stdout under the verb prefix — it is output,
        // not an error — so CI can both gate on the exit code AND capture it.
        expect(captured.stdout[0]).toMatch(/^rosetta diff: com\.example\.app:/);
        expect(captured.stdout[0]).toContain('obfuscated aaaa -> zzzz');
        expect(captured.stderr).toEqual([]);
    });

    it('exits 0 without --exit-code even when the diff is non-empty', async () => {
        const fs = makeFakeFs({ 'a.json': MAP_A, 'b.json': MAP_B });
        const captured = makeCaptured();
        const code = await route(['diff', 'a.json', 'b.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
    });
});
