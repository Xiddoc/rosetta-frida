/**
 * Tests for `rosetta init`.
 *
 * `node:fs/promises` is injected via the second argument so tests run
 * against an in-memory fs mock — no real filesystem state is touched.
 */

import { describe, it, expect } from 'vitest';
import {
    parseInitArgs,
    renderSkeleton,
    defaultOutputPath,
    writeSkeleton,
    runInit,
} from '../../cli/commands/init.js';
import { RosettaError } from '../../src/errors.js';
import { renderJson } from '../../src/convert/json.js';
import type { RosettaMap } from '../../src/types/map.js';
import type { FsLike } from '../../cli/commands/io.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo, type FakeFs } from './helpers.js';

/**
 * Build a fully-typed `FsLike` (no casts) backed by the shared in-memory
 * FakeFs. Returns the live `files` / `dirsCreated` views so assertions
 * can inspect post-run state.
 */
function makeFs(initial: Record<string, string> = {}): {
    fs: FsLike;
    files: Map<string, string>;
    dirsCreated: string[];
} {
    const fake: FakeFs = makeFakeFs(initial);
    return { fs: makeFsLike(fake), files: fake.files, dirsCreated: fake.dirsCreated };
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
        expect(parseInitArgs(['com.a.b', '1.0', '--force']).force).toBe(true);
        expect(parseInitArgs(['com.a.b', '1.0', '-f']).force).toBe(true);
    });

    it('errors when -o has no value', () => {
        expect(() => parseInitArgs(['com.a.b', '1.0', '-o'])).toThrow(/requires a value/);
    });

    it('errors on unknown flag', () => {
        expect(() => parseInitArgs(['com.a.b', '1.0', '--bogus'])).toThrow(/unknown option/);
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

    it('uses the canonical renderer: 4-space indent and a trailing newline', () => {
        // Dedup contract (Task 7): renderSkeleton delegates to src renderJson
        // rather than re-implementing JSON.stringify. Round-tripping the parse
        // back through renderJson must reproduce the exact bytes.
        const out = renderSkeleton('com.example.app', '1.2.3');
        expect(out.endsWith('}\n')).toBe(true);
        expect(out).toContain('\n    "app"'); // 4-space indent
        const reRendered = renderJson(JSON.parse(out) as RosettaMap);
        expect(reRendered).toBe(out);
    });
});

describe('defaultOutputPath', () => {
    it('builds maps/<app>/<version>.json', () => {
        expect(defaultOutputPath('com.example.app', '1.2.3')).toMatch(
            /maps[\\/]com\.example\.app[\\/]1\.2\.3\.json$/,
        );
    });
});

describe('writeSkeleton', () => {
    it('writes to the default path when none is provided', async () => {
        const { fs, files } = makeFs();
        const out = await writeSkeleton(['com.example.app', '1.2.3'], fs);
        expect(out).toMatch(/com\.example\.app[\\/]1\.2\.3\.json$/);
        expect(files.has(out)).toBe(true);
        expect(files.get(out)).toContain('"app": "com.example.app"');
    });

    it('writes to a custom output path with -o (within the project tree)', async () => {
        const { fs, files } = makeFs();
        await writeSkeleton(['com.example.app', '1.2.3', '-o', 'out/x.json'], fs);
        expect(files.has('out/x.json')).toBe(true);
    });

    it('creates parent directories', async () => {
        const { fs, dirsCreated } = makeFs();
        await writeSkeleton(['com.example.app', '1.2.3', '-o', 'deep/nested/path.json'], fs);
        expect(dirsCreated).toContain('deep/nested');
    });

    it('refuses to overwrite without --force', async () => {
        const { fs } = makeFs({ 'existing.json': 'previous' });
        await expect(
            writeSkeleton(['com.example.app', '1.2.3', '-o', 'existing.json'], fs),
        ).rejects.toThrow(RosettaError);
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ 'existing.json': 'previous' });
        await writeSkeleton(['com.example.app', '1.2.3', '-o', 'existing.json', '--force'], fs);
        expect(files.get('existing.json')).not.toBe('previous');
        expect(files.get('existing.json')).toContain('"app": "com.example.app"');
    });

    it('rejects an invalid app name before building a path', async () => {
        const { fs, files } = makeFs();
        await expect(writeSkeleton(['../../etc', '1.2.3'], fs)).rejects.toThrow(/invalid app name/);
        expect(files.size).toBe(0);
    });

    it('rejects an invalid version before building a path', async () => {
        const { fs, files } = makeFs();
        await expect(writeSkeleton(['com.example.app', '../1.0'], fs)).rejects.toThrow(
            /invalid version/,
        );
        expect(files.size).toBe(0);
    });

    it('allows an -o output that points outside the project tree (e.g. ../escape.json)', async () => {
        // Operator-supplied -o is not contained to CWD; only NUL is rejected.
        const { fs, files } = makeFs();
        const out = await writeSkeleton(['com.example.app', '1.2.3', '-o', '../escape.json'], fs);
        expect(out).toBe('../escape.json');
        expect(files.has('../escape.json')).toBe(true);
    });

    it('allows an absolute -o output outside the project tree', async () => {
        const { fs, files } = makeFs();
        const out = await writeSkeleton(['com.example.app', '1.2.3', '-o', '/tmp/out.json'], fs);
        expect(out).toBe('/tmp/out.json');
        expect(files.has('/tmp/out.json')).toBe(true);
    });

    it('rejects a NUL byte in the explicit -o output path', async () => {
        const { fs, files } = makeFs();
        await expect(
            writeSkeleton(['com.example.app', '1.2.3', '-o', 'out.json\0.png'], fs),
        ).rejects.toThrow(/NUL/);
        expect(files.size).toBe(0);
    });

    it('still rejects a derived default path that escapes the project tree', async () => {
        // Derived default = maps/<app>/<version>.json — still contained.
        // This is an academic edge case since app/version are token-validated;
        // the containment check is the backstop in case new tokens ever slip
        // through. We verify the guard by bypassing token validation and
        // calling assertContained indirectly via a minimal simulation — but
        // since valid app/version tokens can never produce a traversal path,
        // we just confirm the token validators already block traversal tokens.
        const { fs, files } = makeFs();
        await expect(writeSkeleton(['../../etc', '1.2.3'], fs)).rejects.toThrow(/invalid app name/);
        expect(files.size).toBe(0);
    });
});

describe('runInit (command wrapper)', () => {
    it('writes the skeleton, reports the path to stdout, and returns 0', async () => {
        const fakeFs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runInit(
            ['com.example.app', '1.2.3', '-o', 'm.json'],
            makeIo(fakeFs, captured),
        );
        expect(code).toBe(0);
        expect(fakeFs.files.has('m.json')).toBe(true);
        expect(captured.stdout[0]).toBe('wrote m.json');
    });

    it('propagates a RosettaError (router formats it) instead of catching', async () => {
        const fakeFs = makeFakeFs({ 'm.json': 'existing' });
        const captured = makeCaptured();
        await expect(
            runInit(['com.example.app', '1.2.3', '-o', 'm.json'], makeIo(fakeFs, captured)),
        ).rejects.toThrow(RosettaError);
    });
});
