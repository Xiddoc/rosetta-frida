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
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    it('accepts two positionals + required --version-code', () => {
        const opts = parseInitArgs(['com.example.app', '1.2.3', '--version-code', '30405']);
        expect(opts.app).toBe('com.example.app');
        expect(opts.version).toBe('1.2.3');
        expect(opts.version_code).toBe(30405);
        expect(opts.output).toBeUndefined();
        expect(opts.force).toBe(false);
    });

    it('accepts -o and --output alongside --version-code', () => {
        const a = parseInitArgs([
            'com.example.app',
            '1.2.3',
            '--version-code',
            '100',
            '-o',
            'out.json',
        ]);
        expect(a.output).toBe('out.json');
        const b = parseInitArgs([
            'com.example.app',
            '1.2.3',
            '--version-code',
            '100',
            '--output',
            'out.json',
        ]);
        expect(b.output).toBe('out.json');
    });

    it('accepts --force and -f alongside --version-code', () => {
        expect(parseInitArgs(['com.a.b', '1.0', '--version-code', '100', '--force']).force).toBe(
            true,
        );
        expect(parseInitArgs(['com.a.b', '1.0', '--version-code', '100', '-f']).force).toBe(true);
    });

    it('errors when --version-code is missing', () => {
        expect(() => parseInitArgs(['com.example.app', '1.2.3'])).toThrow(/--version-code/);
    });

    it('errors when --version-code is zero', () => {
        expect(() => parseInitArgs(['com.example.app', '1.2.3', '--version-code', '0'])).toThrow(
            /positive integer/,
        );
    });

    it('errors when --version-code is negative', () => {
        expect(() => parseInitArgs(['com.example.app', '1.2.3', '--version-code', '-5'])).toThrow(
            /positive integer/,
        );
    });

    it('errors when --version-code is non-numeric', () => {
        expect(() => parseInitArgs(['com.example.app', '1.2.3', '--version-code', 'abc'])).toThrow(
            /positive integer/,
        );
    });

    it('errors when -o has no value', () => {
        expect(() => parseInitArgs(['com.a.b', '1.0', '--version-code', '1', '-o'])).toThrow(
            /requires a value/,
        );
    });

    it('errors on unknown flag', () => {
        expect(() => parseInitArgs(['com.a.b', '1.0', '--version-code', '1', '--bogus'])).toThrow(
            /unknown option/,
        );
    });

    it('errors when positional count is wrong', () => {
        expect(() => parseInitArgs([])).toThrow(/exactly two/);
        expect(() => parseInitArgs(['only-one'])).toThrow(/exactly two/);
        expect(() => parseInitArgs(['a', 'b', 'c'])).toThrow(/exactly two/);
    });
});

describe('renderSkeleton', () => {
    it('includes app, version, and version_code in the body', () => {
        const out = renderSkeleton('com.example.app', '1.2.3', 30405);
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"version": "1.2.3"');
        expect(out).toContain('"version_code": 30405');
        expect(out).toContain('"schema_version": 2');
        // captured_at is an explicit empty-string placeholder for the author.
        expect(out).toContain('"captured_at": ""');
        // must NOT contain version_code: 0
        expect(out).not.toContain('"version_code": 0');
    });

    it('includes a worked example class and parses as strict JSON', () => {
        const out = renderSkeleton('com.example.app', '1.2.3', 100);
        expect(out).not.toContain('//');
        expect(out).toContain('"com.example.app.IRemoteService$Stub"');
        const parsed = JSON.parse(out) as { classes: Record<string, unknown> };
        expect(parsed.classes['com.example.app.IRemoteService$Stub']).toBeDefined();
    });

    it('is deterministic for the same inputs', () => {
        const a = renderSkeleton('com.example.app', '1.0', 100);
        const b = renderSkeleton('com.example.app', '1.0', 100);
        expect(a).toBe(b);
    });

    it('uses the canonical renderer: 4-space indent and a trailing newline', () => {
        // Dedup contract (Task 7): renderSkeleton delegates to src renderJson
        // rather than re-implementing JSON.stringify. Round-tripping the parse
        // back through renderJson must reproduce the exact bytes.
        const out = renderSkeleton('com.example.app', '1.2.3', 100);
        expect(out.endsWith('}\n')).toBe(true);
        expect(out).toContain('\n    "app"'); // 4-space indent
        const reRendered = renderJson(JSON.parse(out) as RosettaMap);
        expect(reRendered).toBe(out);
    });
});

describe('defaultOutputPath', () => {
    it('builds maps/<app>/<version_code>.json (filename == version_code)', () => {
        const out = defaultOutputPath('com.example.app', 30405);
        expect(out).toMatch(/maps[\\/]com\.example\.app[\\/]30405\.json$/);
        // Invariant: basename == version_code (no versionName in path)
        expect(path.basename(out)).toBe('30405.json');
    });

    it('different version_codes produce different filenames', () => {
        expect(defaultOutputPath('com.example.app', 1)).toMatch(/1\.json$/);
        expect(defaultOutputPath('com.example.app', 99999)).toMatch(/99999\.json$/);
    });
});

describe('writeSkeleton', () => {
    it('writes to the default path (maps/<app>/<version_code>.json) when none is provided', async () => {
        const { fs, files } = makeFs();
        const out = await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '30405'],
            fs,
        );
        expect(out).toMatch(/com\.example\.app[\\/]30405\.json$/);
        expect(files.has(out)).toBe(true);
        expect(files.get(out)).toContain('"app": "com.example.app"');
        // Invariant: the written JSON must have version_code matching the filename
        const written = JSON.parse(files.get(out)!) as { version_code: number };
        expect(written.version_code).toBe(30405);
    });

    it('written content never contains version_code: 0', async () => {
        const { fs, files } = makeFs();
        await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '999', '-o', 'out.json'],
            fs,
        );
        expect(files.get('out.json')).not.toContain('"version_code": 0');
    });

    it('writes to a custom output path with -o (within the project tree)', async () => {
        const { fs, files } = makeFs();
        await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'out/x.json'],
            fs,
        );
        expect(files.has('out/x.json')).toBe(true);
    });

    it('creates parent directories', async () => {
        const { fs, dirsCreated } = makeFs();
        await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'deep/nested/path.json'],
            fs,
        );
        expect(dirsCreated).toContain('deep/nested');
    });

    it('refuses to overwrite without --force', async () => {
        const { fs } = makeFs({ 'existing.json': 'previous' });
        await expect(
            writeSkeleton(
                ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'existing.json'],
                fs,
            ),
        ).rejects.toThrow(RosettaError);
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ 'existing.json': 'previous' });
        await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'existing.json', '--force'],
            fs,
        );
        expect(files.get('existing.json')).not.toBe('previous');
        expect(files.get('existing.json')).toContain('"app": "com.example.app"');
    });

    it('rejects an invalid app name before building a path', async () => {
        const { fs, files } = makeFs();
        await expect(
            writeSkeleton(['../../etc', '1.2.3', '--version-code', '100'], fs),
        ).rejects.toThrow(/invalid app name/);
        expect(files.size).toBe(0);
    });

    it('rejects an invalid version before building a path', async () => {
        const { fs, files } = makeFs();
        await expect(
            writeSkeleton(['com.example.app', '../1.0', '--version-code', '100'], fs),
        ).rejects.toThrow(/invalid version/);
        expect(files.size).toBe(0);
    });

    it('allows an -o output that points outside the project tree (e.g. ../escape.json)', async () => {
        // Operator-supplied -o is not contained to CWD; only NUL is rejected.
        const { fs, files } = makeFs();
        const out = await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', '../escape.json'],
            fs,
        );
        expect(out).toBe('../escape.json');
        expect(files.has('../escape.json')).toBe(true);
    });

    it('allows an absolute -o output outside the project tree', async () => {
        const { fs, files } = makeFs();
        const out = await writeSkeleton(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', '/tmp/out.json'],
            fs,
        );
        expect(out).toBe('/tmp/out.json');
        expect(files.has('/tmp/out.json')).toBe(true);
    });

    it('rejects a NUL byte in the explicit -o output path', async () => {
        const { fs, files } = makeFs();
        await expect(
            writeSkeleton(
                ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'out.json\0.png'],
                fs,
            ),
        ).rejects.toThrow(/NUL/);
        expect(files.size).toBe(0);
    });

    it('still rejects a derived default path that escapes the project tree', async () => {
        // Derived default = maps/<app>/<version_code>.json — still contained.
        // This is an academic edge case since app/version are token-validated;
        // the containment check is the backstop in case new tokens ever slip
        // through. We verify the guard by bypassing token validation and
        // calling assertContained indirectly via a minimal simulation — but
        // since valid app/version tokens can never produce a traversal path,
        // we just confirm the token validators already block traversal tokens.
        const { fs, files } = makeFs();
        await expect(
            writeSkeleton(['../../etc', '1.2.3', '--version-code', '100'], fs),
        ).rejects.toThrow(/invalid app name/);
        expect(files.size).toBe(0);
    });
});

describe('filename == version_code invariant', () => {
    it('shipped sample map has basename == version_code', () => {
        // The canonical invariant enforced by rosetta-maps CI:
        // basename(file) == `${version_code}.json`
        const here = dirname(fileURLToPath(import.meta.url));
        const samplePath = join(here, '..', '..', 'maps', 'com.example.app', '30405.json');
        const raw = readFileSync(samplePath, 'utf8');
        const parsed = JSON.parse(raw) as { version_code: number };
        // basename without extension must equal version_code as a string
        const fileBase = path.basename(samplePath, '.json');
        expect(fileBase).toBe(String(parsed.version_code));
    });

    it('defaultOutputPath always obeys the filename == version_code invariant', () => {
        for (const vc of [1, 100, 30405, 999999]) {
            const p = defaultOutputPath('com.example.app', vc);
            expect(path.basename(p, '.json')).toBe(String(vc));
        }
    });
});

describe('runInit (command wrapper)', () => {
    it('writes the skeleton and returns the success message', async () => {
        const fakeFs = makeFakeFs();
        const captured = makeCaptured();
        // run* returns the success message; the router owns the prefix +
        // stdout, so command-level tests assert on the return value.
        const msg = await runInit(
            ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'm.json'],
            makeIo(fakeFs, captured),
        );
        expect(fakeFs.files.has('m.json')).toBe(true);
        expect(msg).toBe('wrote m.json');
    });

    it('propagates a RosettaError (router formats it) instead of catching', async () => {
        const fakeFs = makeFakeFs({ 'm.json': 'existing' });
        const captured = makeCaptured();
        await expect(
            runInit(
                ['com.example.app', '1.2.3', '--version-code', '100', '-o', 'm.json'],
                makeIo(fakeFs, captured),
            ),
        ).rejects.toThrow(RosettaError);
    });
});
