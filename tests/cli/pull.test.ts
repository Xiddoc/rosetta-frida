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
    isPinnedRef,
    assertValidPullConfig,
    defaultPullConfig,
    MAX_MAP_BYTES,
    type PullConfig,
    type PullResponse,
} from '../../cli/commands/pull.js';
import { RosettaError } from '../../src/errors.js';
import type { FsLike } from '../../cli/commands/io.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo, type FakeFs } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid schema_version:3 map as a JSON string. */
const VALID_MAP_JSON = JSON.stringify({
    schema_version: 4,
    app: 'com.example.app',
    version: '3.4.5',
    version_code: 30405,
    classes: {
        'com.example.app.IRemoteService$Stub': { obfuscated: 'aaaa' },
    },
});

/** One canned HTTP response for the mock fetch seam. */
function makeResponse(
    payload: string,
    status = 200,
    headers?: Record<string, string>,
): PullResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(payload),
        headers: headers ? { get: (name) => headers[name.toLowerCase()] ?? null } : undefined,
    };
}

/** Options for {@link mockConfig}. */
interface MockOpts {
    status?: number;
    headers?: Record<string, string>;
}

/**
 * Build a mock PullConfig whose fetch seam returns the map payload. No
 * byte-hash sidecar is fetched any more (maps#37 / frida#21): a map is pure
 * data and transport integrity comes from git-over-HTTPS, so there is no
 * `.sha256` request to route.
 */
function mockConfig(payload: string, opts: MockOpts = {}): PullConfig {
    return {
        mapsRepoBaseUrl: 'https://raw.example.com/rosetta-maps',
        mapsRepoRef: 'abc123',
        fetch: (_url: string) =>
            Promise.resolve(makeResponse(payload, opts.status ?? 200, opts.headers)),
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

    it('rejects scientific notation (@1e3) — digits only', () => {
        expect(() => parsePullTarget('com.example.app@1e3')).toThrow(/decimal digits only/);
    });

    it('rejects a target with more than one @', () => {
        expect(() => parsePullTarget('com.example.app@30405@extra')).toThrow(/exactly one/);
    });

    it('rejects a leading-+ version_code', () => {
        expect(() => parsePullTarget('com.example.app@+5')).toThrow(/decimal digits only/);
    });

    it('rejects whitespace-padded version_code', () => {
        expect(() => parsePullTarget('com.example.app@ 5')).toThrow(/decimal digits only/);
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

    it('rejects the removed --require-sidecar flag as unknown', () => {
        // The byte-hash sidecar was removed (maps#37 / frida#21); its CLI flag
        // is gone and must now be reported as an unknown option.
        expect(() => parsePullArgs(['com.example.app@30405', '--require-sidecar'])).toThrow(
            /unknown option/,
        );
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
// defaultPullConfig
// ---------------------------------------------------------------------------

describe('defaultPullConfig', () => {
    it('points at the canonical rosetta-maps repo on the main branch', () => {
        const cfg = defaultPullConfig();
        expect(cfg.mapsRepoBaseUrl).toBe('https://raw.githubusercontent.com/Xiddoc/rosetta-maps');
        expect(cfg.mapsRepoRef).toBe('main');
        expect(typeof cfg.fetch).toBe('function');
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
    it('returns the body text and fetched URL on HTTP 200', async () => {
        const result = await fetchMapJson('com.example.app', 30405, mockConfig(VALID_MAP_JSON));
        expect(result.body).toBe(VALID_MAP_JSON);
        expect(result.url).toBe(
            'https://raw.example.com/rosetta-maps/abc123/maps/com.example.app/30405.json',
        );
    });

    it('throws a loud error on HTTP 404 (exact miss)', async () => {
        await expect(
            fetchMapJson('com.example.app', 99999, mockConfig('Not Found', { status: 404 })),
        ).rejects.toThrow(/no map found for com\.example\.app@99999/);
    });

    it('error on 404 includes actionable guidance (GitHub URL)', async () => {
        await expect(
            fetchMapJson('com.example.app', 99999, mockConfig('', { status: 404 })),
        ).rejects.toThrow(/https:\/\/github\.com\/Xiddoc\/rosetta-maps/);
    });

    it('throws on non-200 non-404 HTTP status', async () => {
        await expect(
            fetchMapJson('com.example.app', 30405, mockConfig('Server Error', { status: 500 })),
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

    it('rejects an oversize body by Content-Length pre-check', async () => {
        const cfg = mockConfig('{}', { headers: { 'content-length': String(MAX_MAP_BYTES + 1) } });
        await expect(fetchMapJson('com.example.app', 30405, cfg)).rejects.toThrow(
            /too large: Content-Length/,
        );
    });

    it('ignores a non-numeric Content-Length and falls through to the body check', async () => {
        // Header lies/garbled → pre-check is skipped; small body passes.
        const cfg = mockConfig(VALID_MAP_JSON, { headers: { 'content-length': 'not-a-number' } });
        await expect(fetchMapJson('com.example.app', 30405, cfg)).resolves.toMatchObject({
            body: VALID_MAP_JSON,
        });
    });

    it('rejects an oversize body by decoded length even when no header is present', async () => {
        const huge = 'x'.repeat(MAX_MAP_BYTES + 1);
        await expect(fetchMapJson('com.example.app', 30405, mockConfig(huge))).rejects.toThrow(
            /too large: \d+ bytes/,
        );
    });

    it('accepts a body exactly at the limit', async () => {
        // No header; body length == MAX is allowed (only strictly over rejects).
        const atLimit = 'y'.repeat(MAX_MAP_BYTES);
        await expect(
            fetchMapJson('com.example.app', 30405, mockConfig(atLimit)),
        ).resolves.toMatchObject({ body: atLimit });
    });
});

// ---------------------------------------------------------------------------
// isPinnedRef / assertValidPullConfig
// ---------------------------------------------------------------------------

describe('isPinnedRef', () => {
    it('treats a full 40-hex SHA as pinned', () => {
        expect(isPinnedRef('a'.repeat(40))).toBe(true);
        expect(isPinnedRef('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    });

    it('treats a vX.Y.Z tag as pinned', () => {
        expect(isPinnedRef('v1.2.3')).toBe(true);
        expect(isPinnedRef('v10.0.0-rc1')).toBe(true);
    });

    it('treats a vX.Y.Z tag with a prerelease/build suffix as pinned', () => {
        expect(isPinnedRef('v1.2.3-rc1')).toBe(true);
        expect(isPinnedRef('v1.2.3+build.5')).toBe(true);
    });

    it('treats a moving ref that merely starts with a tag prefix as unpinned (anchored)', () => {
        // A branch whose name starts vX.Y.Z but continues with a non-suffix
        // character (slash / space) must NOT be misread as a pinned release.
        expect(isPinnedRef('v1.2.3-feature/foo')).toBe(false);
        expect(isPinnedRef('v1.2.3 wip')).toBe(false);
        // Four numeric segments is not a vX.Y.Z tag either.
        expect(isPinnedRef('v1.2.3.4')).toBe(false);
    });

    it('treats a branch name like main as unpinned', () => {
        expect(isPinnedRef('main')).toBe(false);
        expect(isPinnedRef('develop')).toBe(false);
    });

    it('treats a short SHA as unpinned (not 40 hex)', () => {
        expect(isPinnedRef('abc1234')).toBe(false);
    });
});

describe('assertValidPullConfig', () => {
    function cfg(over: Partial<PullConfig>): PullConfig {
        return { ...mockConfig(''), ...over };
    }

    it('throws on a malformed base URL', () => {
        expect(() => assertValidPullConfig(cfg({ mapsRepoBaseUrl: 'not a url' }))).toThrow(
            /valid URL/,
        );
    });

    it('throws on a base URL with a trailing slash', () => {
        expect(() =>
            assertValidPullConfig(cfg({ mapsRepoBaseUrl: 'https://x.example.com/' })),
        ).toThrow(/trailing slash/);
    });

    it('throws on an empty ref', () => {
        expect(() => assertValidPullConfig(cfg({ mapsRepoRef: '' }))).toThrow(/non-empty git ref/);
    });

    it('warns when the ref is the moving branch main', () => {
        const warnings: string[] = [];
        assertValidPullConfig(cfg({ mapsRepoRef: 'main' }), (l) => warnings.push(l));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/not pinned/);
    });

    it('does NOT warn when the ref is a pinned SHA', () => {
        const warnings: string[] = [];
        assertValidPullConfig(cfg({ mapsRepoRef: 'a'.repeat(40) }), (l) => warnings.push(l));
        expect(warnings).toHaveLength(0);
    });

    it('does not throw when no warn writer is given (warning is suppressed silently)', () => {
        expect(() => assertValidPullConfig(cfg({ mapsRepoRef: 'main' }))).not.toThrow();
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
            writePulledMap(['com.example.app@99999'], fs, mockConfig('Not Found', { status: 404 })),
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
            schema_version: 4,
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

    it('accepts a map whose identity matches the request', async () => {
        const { fs, files } = makeFs();
        const out = await writePulledMap(['com.example.app@30405'], fs, mockConfig(VALID_MAP_JSON));
        expect(files.has(out)).toBe(true);
    });

    it('rejects a map whose app field does not match the request', async () => {
        // Requested com.other.app but the upstream file declares com.example.app.
        const { fs } = makeFs();
        await expect(
            writePulledMap(['com.other.app@30405'], fs, mockConfig(VALID_MAP_JSON)),
        ).rejects.toThrow(
            /identity does not match.*com\.other\.app@30405.*com\.example\.app@30405/s,
        );
    });

    it('rejects a map whose version_code does not match the request', async () => {
        // The upstream file at this name declares 30405, not the requested 99.
        const mismatched = JSON.stringify({
            schema_version: 4,
            app: 'com.example.app',
            version: '9.9',
            version_code: 30405,
            classes: { 'com.example.app.X': { obfuscated: 'aaaa' } },
        });
        const { fs } = makeFs();
        const cfg = mockConfig(mismatched);
        await expect(writePulledMap(['com.example.app@99'], fs, cfg)).rejects.toThrow(
            /identity does not match.*com\.example\.app@99.*com\.example\.app@30405/s,
        );
    });

    it('rejects an oversize fetched body (DoS guard)', async () => {
        const huge = 'z'.repeat(MAX_MAP_BYTES + 1);
        const { fs } = makeFs();
        await expect(
            writePulledMap(['com.example.app@30405'], fs, mockConfig(huge)),
        ).rejects.toThrow(/too large/);
    });

    it('rejects a malformed config before any fetch', async () => {
        const { fs } = makeFs();
        const bad: PullConfig = { ...mockConfig(VALID_MAP_JSON), mapsRepoBaseUrl: 'not a url' };
        await expect(writePulledMap(['com.example.app@30405'], fs, bad)).rejects.toThrow(
            /invalid pull config/,
        );
    });

    it('makes no second (sidecar) fetch — a map is pure data, no byte-hash sidecar', async () => {
        // Regression guard for maps#37 / frida#21: pull must issue exactly ONE
        // fetch (the map), never a `.sha256` sidecar request.
        const { fs } = makeFs();
        const urls: string[] = [];
        const cfg: PullConfig = {
            ...mockConfig(VALID_MAP_JSON),
            fetch: (url) => {
                urls.push(url);
                return Promise.resolve(makeResponse(VALID_MAP_JSON));
            },
        };
        await writePulledMap(['com.example.app@30405'], fs, cfg);
        expect(urls).toHaveLength(1);
        expect(urls[0]!.endsWith('.sha256')).toBe(false);
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

    it('emits the unpinned-ref warning to stderr (not stdout)', async () => {
        const fakeFs = makeFakeFs();
        const captured = makeCaptured();
        const unpinned: PullConfig = { ...mockConfig(VALID_MAP_JSON), mapsRepoRef: 'main' };
        await runPull(
            ['com.example.app@30405', '-o', 'm.json'],
            makeIo(fakeFs, captured),
            unpinned,
        );
        expect(captured.stderr.some((l) => /not pinned/.test(l))).toBe(true);
        expect(captured.stdout).toEqual([]);
    });

    it('does not warn for a pinned ref', async () => {
        const fakeFs = makeFakeFs();
        const captured = makeCaptured();
        const pinned: PullConfig = { ...mockConfig(VALID_MAP_JSON), mapsRepoRef: 'v1.0.0' };
        await runPull(['com.example.app@30405', '-o', 'm.json'], makeIo(fakeFs, captured), pinned);
        expect(captured.stderr).toEqual([]);
    });
});
