/**
 * Tests for `rosetta init`.
 *
 * `node:fs/promises` is injected via the second argument so tests run
 * against an in-memory fs mock — no real filesystem state is touched.
 */

import { describe, it, expect } from 'vitest';
import type * as fsMod from 'node:fs/promises';
import {
    parseInitArgs,
    renderSkeleton,
    defaultOutputPath,
    runInit,
} from '../../cli/commands/init.js';
import { RosettaError } from '../../src/errors.js';

function enoent(p: string): NodeJS.ErrnoException {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
}

/**
 * Minimal in-memory fs that backs the subset of node:fs/promises that
 * runInit uses. Returns a `Promise.reject(...)` with `ENOENT` for missing
 * files (so `stat` mimics the real behavior). Each operation returns
 * a Promise directly rather than being an async function, so eslint's
 * `require-await` doesn't complain.
 */
function makeFs(initial: Record<string, string> = {}): {
    fs: typeof fsMod;
    files: Map<string, string>;
    dirsCreated: string[];
} {
    const files = new Map<string, string>(Object.entries(initial));
    const dirsCreated: string[] = [];
    const fs = {
        stat(p: string) {
            return files.has(p)
                ? Promise.resolve({ isFile: () => true } as fsMod.Stats)
                : Promise.reject(enoent(p));
        },
        mkdir(p: string) {
            dirsCreated.push(p);
            return Promise.resolve(undefined);
        },
        writeFile(p: string, content: string) {
            files.set(p, content);
            return Promise.resolve();
        },
    } as unknown as typeof fsMod;
    return { fs, files, dirsCreated };
}

describe('parseInitArgs', () => {
    it('accepts two positionals', () => {
        const opts = parseInitArgs(['com.example.app', '1.2.3']);
        expect(opts.app).toBe('com.example.app');
        expect(opts.version).toBe('1.2.3');
        expect(opts.output).toBeUndefined();
        expect(opts.force).toBe(false);
    });

    it('accepts -o and --output', () => {
        const a = parseInitArgs(['com.example.app', '1.2.3', '-o', 'out.json']);
        expect(a.output).toBe('out.json');
        const b = parseInitArgs(['com.example.app', '1.2.3', '--output', 'out.json']);
        expect(b.output).toBe('out.json');
    });

    it('accepts --force and -f', () => {
        expect(parseInitArgs(['x', 'y', '--force']).force).toBe(true);
        expect(parseInitArgs(['x', 'y', '-f']).force).toBe(true);
    });

    it('errors when -o has no value', () => {
        expect(() => parseInitArgs(['x', 'y', '-o'])).toThrow(/requires a value/);
    });

    it('errors on unknown flag', () => {
        expect(() => parseInitArgs(['x', 'y', '--bogus'])).toThrow(/unknown flag/);
    });

    it('errors when positional count is wrong', () => {
        expect(() => parseInitArgs([])).toThrow(/exactly two/);
        expect(() => parseInitArgs(['only-one'])).toThrow(/exactly two/);
        expect(() => parseInitArgs(['a', 'b', 'c'])).toThrow(/exactly two/);
    });
});

describe('renderSkeleton', () => {
    it('includes app and version in the body', () => {
        const out = renderSkeleton('com.example.app', '1.2.3');
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"version": "1.2.3"');
        expect(out).toContain('"schema_version": 2');
        expect(out).toContain('"version_code": 0');
    });

    it('includes a worked example class and parses as strict JSON', () => {
        const out = renderSkeleton('com.example.app', '1.2.3');
        expect(out).not.toContain('//');
        expect(out).toContain('"com.example.app.IRemoteService$Stub"');
        const parsed = JSON.parse(out) as { classes: Record<string, unknown> };
        expect(parsed.classes['com.example.app.IRemoteService$Stub']).toBeDefined();
    });

    it('is deterministic for the same inputs', () => {
        const a = renderSkeleton('com.example.app', '1.0');
        const b = renderSkeleton('com.example.app', '1.0');
        expect(a).toBe(b);
    });
});

describe('defaultOutputPath', () => {
    it('builds maps/<app>/<version>.json', () => {
        expect(defaultOutputPath('com.example.app', '1.2.3')).toMatch(
            /maps[\\/]com\.example\.app[\\/]1\.2\.3\.json$/,
        );
    });
});

describe('runInit', () => {
    it('writes to the default path when none is provided', async () => {
        const { fs, files } = makeFs();
        const out = await runInit(['com.example.app', '1.2.3'], fs);
        expect(out).toMatch(/com\.example\.app[\\/]1\.2\.3\.json$/);
        expect(files.has(out)).toBe(true);
        expect(files.get(out)).toContain('"app": "com.example.app"');
    });

    it('writes to a custom output path with -o', async () => {
        const { fs, files } = makeFs();
        await runInit(['com.example.app', '1.2.3', '-o', '/tmp/x.json'], fs);
        expect(files.has('/tmp/x.json')).toBe(true);
    });

    it('creates parent directories', async () => {
        const { fs, dirsCreated } = makeFs();
        await runInit(['com.example.app', '1.2.3', '-o', 'deep/nested/path.json'], fs);
        expect(dirsCreated).toContain('deep/nested');
    });

    it('refuses to overwrite without --force', async () => {
        const { fs } = makeFs({ '/tmp/existing.json': 'previous' });
        await expect(runInit(['x', 'y', '-o', '/tmp/existing.json'], fs)).rejects.toThrow(
            RosettaError,
        );
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ '/tmp/existing.json': 'previous' });
        await runInit(['x', 'y', '-o', '/tmp/existing.json', '--force'], fs);
        expect(files.get('/tmp/existing.json')).not.toBe('previous');
        expect(files.get('/tmp/existing.json')).toContain('"app": "x"');
    });
});
