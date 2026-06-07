/**
 * Tests for `rosetta pull`.
 *
 * All network calls are mocked via the injected {@link PullConfig.fetch}
 * seam — no real HTTP requests are made. Filesystem operations use the
 * shared in-memory FakeFs so no real disk is touched.
 */

import { describe, it, expect } from 'vitest';
import {
    parsePullArgs,
    parsePullTarget,
    buildMapUrl,
    fetchMapJson,
    writePulledMap,
    runPull,
    defaultMapPath,
    type PullConfig,
} from '../../cli/commands/pull.js';
import { RosettaError } from '../../src/errors.js';
import type { FsLike } from '../../cli/commands/io.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo, type FakeFs } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid schema_version:2 map as a JSON string. */
const VALID_MAP_JSON = JSON.stringify({
    schema_version: 2,
    app: 'com.example.app',
    version: '3.4.5',
    version_code: 30405,
    classes: {
        'com.example.app.IRemoteService$Stub': { obfuscated: 'aaaa' },
    },
});

/** Build a mock PullConfig that returns the given JSON payload. */
function mockConfig(payload: string, status = 200): PullConfig {
    return {
        mapsRepoBaseUrl: 'https://raw.example.com/rosetta-maps',
        mapsRepoRef: 'abc123',
        fetch: (_url: string) =>
            Promise.resolve({
                ok: status >= 200 && status < 300,
                status,
                text: () => Promise.resolve(payload),
            }),
    };
}

/** Mock config that throws a network error. */
function networkErrorConfig(): PullConfig {
    return {
        mapsRepoBaseUrl: 'https://raw.example.com/rosetta-maps',
        mapsRepoRef: 'abc123',
        fetch: (_url: string) => Promise.reject(new Error('Network unreachable')),
    };
}

function makeFs(initial: Record<string, string> = {}): {
    fs: FsLike;
    files: Map<string, string>;
    dirsCreated: string[];
} {
    const fake: FakeFs = makeFakeFs(initial);
    return { fs: makeFsLike(fake), files: fake.files, dirsCreated: fake.dirsCreated };
}

// ---------------------------------------------------------------------------
// parsePullTarget
// ---------------------------------------------------------------------------

describe('parsePullTarget', () => {
    it('parses a valid <app>@<version_code>', () => {
        const { app, version_code } = parsePullTarget('com.example.app@30405');
        expect(app).toBe('com.example.app');
        expect(version_code).toBe(30405);
    });

    it('handles large version codes', () => {
        const { version_code } = parsePullTarget('com.example.app@2000000000');
        expect(version_code).toBe(2000000000);
    });

    it('errors when @ is absent', () => {
        expect(() => parsePullTarget('com.example.app')).toThrow(/app>@<version_code/);
    });

    it('errors when @ is the first character (empty app)', () => {
        expect(() => parsePullTarget('@30405')).toThrow(/app>@<version_code/);
    });

    it('errors when version_code is zero', () => {
        expect(() => parsePullTarget('com.example.app@0')).toThrow(/positive integer/);
    });

    it('errors when version_code is negative', () => {
        expect(() => parsePullTarget('com.example.app@-1')).toThrow(/positive integer/);
    });

    it('errors when version_code is non-numeric', () => {
        expect(() => parsePullTarget('com.example.app@abc')).toThrow(/positive integer/);
    });

    it('errors when version_code is empty after @', () => {
        expect(() => parsePullTarget('com.example.app@')).toThrow(/positive integer/);
    });
});

// ---------------------------------------------------------------------------
// parsePullArgs
// ---------------------------------------------------------------------------

describe('parsePullArgs', () => {
    it('accepts a single <app>@<version_code> positional', () => {
        const opts = parsePullArgs(['com.example.app@30405']);
        expect(opts.app).toBe('com.example.app');
        expect(opts.version_code).toBe(30405);
        expect(opts.output).toBeUndefined();
        expect(opts.force).toBe(false);
    });

    it('accepts -o / --output', () => {
        const a = parsePullArgs(['com.example.app@30405', '-o', 'out.json']);
        expect(a.output).toBe('out.json');
        const b = parsePullArgs(['com.example.app@30405', '--output', 'out.json']);
        expect(b.output).toBe('out.json');
    });

    it('accepts --force / -f', () => {
        expect(parsePullArgs(['com.example.app@30405', '--force']).force).toBe(true);
        expect(parsePullArgs(['com.example.app@30405', '-f']).force).toBe(true);
    });

    it('errors when -o has no value', () => {
        expect(() => parsePullArgs(['com.example.app@30405', '-o'])).toThrow(/requires a value/);
    });

    it('errors on unknown flag', () => {
        expect(() => parsePullArgs(['com.example.app@30405', '--bogus'])).toThrow(/unknown option/);
    });

    it('errors when no positional is given', () => {
        expect(() => parsePullArgs([])).toThrow(/exactly one/);
    });

    it('errors when more than one positional is given', () => {
        expect(() => parsePullArgs(['com.example.app@30405', 'extra'])).toThrow(/exactly one/);
    });

    it('propagates parsePullTarget errors (bad target format)', () => {
        expect(() => parsePullArgs(['com.example.app'])).toThrow(/app>@<version_code/);
    });
});

// ---------------------------------------------------------------------------
// defaultMapPath
// ---------------------------------------------------------------------------

describe('defaultMapPath', () => {
    it('builds maps/<app>/<version_code>.json', () => {
        expect(defaultMapPath('com.example.app', 30405)).toMatch(
            /maps[\\/]com\.example\.app[\\/]30405\.json$/,
        );
    });
});

// ---------------------------------------------------------------------------
// buildMapUrl
// ---------------------------------------------------------------------------

describe('buildMapUrl', () => {
    it('builds the correct raw-content URL', () => {
        const config: PullConfig = {
            mapsRepoBaseUrl: 'https://raw.githubusercontent.com/Xiddoc/rosetta-maps',
            mapsRepoRef: 'main',
            fetch: mockConfig('').fetch,
        };
        const url = buildMapUrl('com.example.app', 30405, config);
        expect(url).toBe(
            'https://raw.githubusercontent.com/Xiddoc/rosetta-maps/main/maps/com.example.app/30405.json',
        );
    });

    it('uses the configured ref (pinned SHA)', () => {
        const config: PullConfig = {
            mapsRepoBaseUrl: 'https://raw.example.com/maps',
            mapsRepoRef: 'abc1234def',
            fetch: mockConfig('').fetch,
        };
        const url = buildMapUrl('com.example.app', 100, config);
        expect(url).toContain('/abc1234def/');
    });
});

// ---------------------------------------------------------------------------
// fetchMapJson
// ---------------------------------------------------------------------------

describe('fetchMapJson', () => {
    it('returns the body text on HTTP 200', async () => {
        const json = await fetchMapJson('com.example.app', 30405, mockConfig(VALID_MAP_JSON));
        expect(json).toBe(VALID_MAP_JSON);
    });

    it('throws a loud error on HTTP 404 (exact miss)', async () => {
        await expect(
            fetchMapJson('com.example.app', 99999, mockConfig('Not Found', 404)),
        ).rejects.toThrow(/no map found for com\.example\.app@99999/);
    });

    it('error on 404 includes actionable guidance (GitHub URL)', async () => {
        await expect(fetchMapJson('com.example.app', 99999, mockConfig('', 404))).rejects.toThrow(
            /https:\/\/github\.com\/Xiddoc\/rosetta-maps/,
        );
    });

    it('throws on non-200 non-404 HTTP status', async () => {
        await expect(
            fetchMapJson('com.example.app', 30405, mockConfig('Server Error', 500)),
        ).rejects.toThrow(/HTTP 500/);
    });

    it('wraps a network error with a useful message', async () => {
        await expect(fetchMapJson('com.example.app', 30405, networkErrorConfig())).rejects.toThrow(
            /network error fetching/,
        );
    });

    it('wraps a non-Error thrown object (string) via String(err)', async () => {
        // Covers the `String(err)` branch in the catch handler.
        const stringThrowConfig: PullConfig = {
            mapsRepoBaseUrl: 'https://raw.example.com',
            mapsRepoRef: 'main',
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            fetch: (_url: string) => Promise.reject('connection refused'),
        };
        await expect(fetchMapJson('com.example.app', 30405, stringThrowConfig)).rejects.toThrow(
            /connection refused/,
        );
    });
});

// ---------------------------------------------------------------------------
// writePulledMap
// ---------------------------------------------------------------------------

describe('writePulledMap', () => {
    it('writes a valid fetched map to the default path', async () => {
        const { fs, files } = makeFs();
        const out = await writePulledMap(['com.example.app@30405'], fs, mockConfig(VALID_MAP_JSON));
        expect(out).toMatch(/com\.example\.app[\\/]30405\.json$/);
        expect(files.has(out)).toBe(true);
        const written = JSON.parse(files.get(out)!) as { version_code: number; app: string };
        expect(written.app).toBe('com.example.app');
        expect(written.version_code).toBe(30405);
    });

    it('writes to a custom output path with -o', async () => {
        const { fs, files } = makeFs();
        await writePulledMap(
            ['com.example.app@30405', '-o', 'custom/out.json'],
            fs,
            mockConfig(VALID_MAP_JSON),
        );
        expect(files.has('custom/out.json')).toBe(true);
    });

    it('creates parent directories', async () => {
        const { fs, dirsCreated } = makeFs();
        await writePulledMap(
            ['com.example.app@30405', '-o', 'deep/dir/out.json'],
            fs,
            mockConfig(VALID_MAP_JSON),
        );
        expect(dirsCreated).toContain('deep/dir');
    });

    it('refuses to overwrite an existing map without --force', async () => {
        const { fs } = makeFs({ 'existing.json': 'old' });
        await expect(
            writePulledMap(
                ['com.example.app@30405', '-o', 'existing.json'],
                fs,
                mockConfig(VALID_MAP_JSON),
            ),
        ).rejects.toThrow(/refusing to overwrite/);
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ 'existing.json': 'old' });
        await writePulledMap(
            ['com.example.app@30405', '-o', 'existing.json', '--force'],
            fs,
            mockConfig(VALID_MAP_JSON),
        );
        expect(files.get('existing.json')).not.toBe('old');
        expect(files.get('existing.json')).toContain('"app"');
    });

    it('fails loudly on a 404 (exact miss)', async () => {
        const { fs } = makeFs();
        await expect(
            writePulledMap(['com.example.app@99999'], fs, mockConfig('Not Found', 404)),
        ).rejects.toThrow(/no map found for com\.example\.app@99999/);
    });

    it('fails on invalid JSON from the remote', async () => {
        const { fs } = makeFs();
        await expect(
            writePulledMap(['com.example.app@30405'], fs, mockConfig('{ not json }')),
        ).rejects.toThrow(/not valid JSON/);
    });

    it('fails on schema-invalid JSON from the remote', async () => {
        // Missing required fields (obfuscated on the class entry)
        const badMap = JSON.stringify({
            schema_version: 2,
            app: 'com.example.app',
            version: '1.0',
            version_code: 1,
            classes: { IFoo: {} }, // missing obfuscated
        });
        const { fs } = makeFs();
        await expect(
            writePulledMap(['com.example.app@1'], fs, mockConfig(badMap)),
        ).rejects.toThrow();
    });

    it('rejects an invalid app name', async () => {
        const { fs } = makeFs();
        await expect(
            writePulledMap(['../../etc@100'], fs, mockConfig(VALID_MAP_JSON)),
        ).rejects.toThrow(/invalid app name/);
    });

    it('rejects a NUL byte in the -o path', async () => {
        const { fs } = makeFs();
        await expect(
            writePulledMap(
                ['com.example.app@30405', '-o', 'out.json\0.png'],
                fs,
                mockConfig(VALID_MAP_JSON),
            ),
        ).rejects.toThrow(/NUL/);
    });

    it('re-renders the fetched content in canonical form', async () => {
        // The fetched JSON may have compact or inconsistent whitespace; the
        // written artifact must use 4-space indent + trailing newline.
        const compact = JSON.stringify(JSON.parse(VALID_MAP_JSON));
        const { fs, files } = makeFs();
        const out = await writePulledMap(['com.example.app@30405'], fs, mockConfig(compact));
        const written = files.get(out)!;
        expect(written.endsWith('}\n')).toBe(true);
        expect(written).toContain('\n    "app"'); // 4-space indent
    });
});

// ---------------------------------------------------------------------------
// runPull (command wrapper)
// ---------------------------------------------------------------------------

describe('runPull', () => {
    it('returns the success message on a happy path', async () => {
        const fakeFs = makeFakeFs();
        const captured = makeCaptured();
        const msg = await runPull(
            ['com.example.app@30405', '-o', 'm.json'],
            makeIo(fakeFs, captured),
            mockConfig(VALID_MAP_JSON),
        );
        expect(fakeFs.files.has('m.json')).toBe(true);
        expect(msg).toBe('wrote m.json');
    });

    it('propagates a RosettaError instead of catching (router formats it)', async () => {
        const fakeFs = makeFakeFs({ 'm.json': 'existing' });
        const captured = makeCaptured();
        await expect(
            runPull(
                ['com.example.app@30405', '-o', 'm.json'],
                makeIo(fakeFs, captured),
                mockConfig(VALID_MAP_JSON),
            ),
        ).rejects.toThrow(RosettaError);
    });
});
