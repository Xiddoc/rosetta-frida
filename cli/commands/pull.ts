/**
 * `rosetta pull <app>@<version_code>`
 *
 * Fetches the single verified map for the given `(app, version_code)` pair
 * from the rosetta-maps community repository, validates it against the
 * schema, and writes it to `maps/<app>/<version_code>.json` in the project.
 *
 * This is a **build-time, developer-machine** operation: the fetch happens
 * once when authoring/bundling a Frida script, not on the target device.
 * The written map can then be bundled via `frida-compile` and imported by
 * the hook script — keeping all network I/O off the device.
 *
 * Source URL and pinned ref flow through {@link PullConfig} so they are
 * auditable and testable without `process.env` lookups scattered around.
 *
 * Exact-miss (unknown app or unknown version_code in the remote repo)
 * fails loudly with an actionable message — a wrong map is worse than no
 * map, so silent fall-backs are explicitly rejected.
 *
 * Refuses to overwrite an existing map unless `--force` is passed.
 */

import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { validateStructure } from '../../src/convert/index.js';
import { parseJson } from '../../src/parse/json.js';
import { assertValidApp, assertContained, assertNoNul } from '../../src/parse/index.js';
import { renderJson } from '../../src/convert/json.js';
import type { CommandIo, FsLike } from './io.js';
import { writeNew } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

// ---------------------------------------------------------------------------
// Typed configuration — source URL/ref must NOT be process.env lookups.
// ---------------------------------------------------------------------------

/**
 * Typed configuration for `rosetta pull`. All network / repo coordinates
 * live here rather than in scattered `process.env` lookups.
 *
 * The defaults point to the canonical rosetta-maps GitHub repository at a
 * pinned ref, ensuring reproducible fetches. Override in tests to avoid
 * real network calls.
 */
export interface PullConfig {
    /**
     * Base raw-content URL for the rosetta-maps repo. Must NOT end with `/`.
     *
     * Default: `https://raw.githubusercontent.com/Xiddoc/rosetta-maps`
     */
    mapsRepoBaseUrl: string;
    /**
     * Git ref (branch, tag, or full SHA) to fetch maps from. Pinning to a
     * SHA gives reproducible fetches; a branch name like `main` always
     * returns the latest contribution.
     *
     * Default: `main`
     */
    mapsRepoRef: string;
    /**
     * HTTP fetch seam — injected so tests can mock it without hitting the
     * real network. Must have the same signature as the WHATWG `fetch` global.
     */
    fetch: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/** Default production config — points at the canonical rosetta-maps repo. */
export function defaultPullConfig(): PullConfig {
    return {
        mapsRepoBaseUrl: 'https://raw.githubusercontent.com/Xiddoc/rosetta-maps',
        mapsRepoRef: 'main',
        fetch: globalThis.fetch.bind(globalThis),
    };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface PullOptions {
    /** Android package name (e.g. `com.example.app`). */
    app: string;
    /** Android versionCode — the authoritative O(1) selection key. */
    version_code: number;
    /** Output path. Defaults to `maps/<app>/<version_code>.json`. */
    output?: string;
    /** Overwrite an existing file at the output path. */
    force?: boolean;
}

/** Option grammar for `pull`: `-o/--output <path>` and `--force/-f`. */
const PULL_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
    ],
};

/**
 * Parse `<app>@<version_code>` from the positional argument.
 *
 * The `@` separator is required — it makes the version_code unambiguous and
 * keeps the single-positional form terse: `rosetta pull com.example.app@30405`.
 */
export function parsePullTarget(raw: string): { app: string; version_code: number } {
    const atIdx = raw.lastIndexOf('@');
    if (atIdx <= 0) {
        throw new RosettaError(
            `pull target must be <app>@<version_code> (e.g. com.example.app@30405); got '${raw}'`,
        );
    }
    const app = raw.slice(0, atIdx);
    const vcRaw = raw.slice(atIdx + 1);
    const version_code = Number(vcRaw);
    if (!Number.isInteger(version_code) || version_code <= 0 || vcRaw.trim() === '') {
        throw new RosettaError(
            `version_code in '${raw}' must be a positive integer; got '${vcRaw}'`,
        );
    }
    return { app, version_code };
}

/** CLI parse — returns parsed options or throws RosettaError on bad args. */
export function parsePullArgs(argv: readonly string[]): PullOptions {
    const { positionals, values, flags } = parseArgs(argv, PULL_SPEC);
    if (positionals.length !== 1) {
        throw new RosettaError(
            `pull requires exactly one positional arg: <app>@<version_code> (got ${positionals.length})`,
        );
    }
    const { app, version_code } = parsePullTarget(positionals[0] as string);
    return {
        app,
        version_code,
        output: values.output,
        force: flags.force ?? false,
    };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Build the raw-content URL for a specific map in the rosetta-maps repo.
 *
 * Format: `<mapsRepoBaseUrl>/<mapsRepoRef>/maps/<app>/<version_code>.json`
 */
export function buildMapUrl(app: string, version_code: number, config: PullConfig): string {
    return `${config.mapsRepoBaseUrl}/${config.mapsRepoRef}/maps/${app}/${version_code}.json`;
}

/**
 * Fetch the map JSON for `(app, version_code)` from the remote repo.
 *
 * Throws a loud {@link RosettaError} on:
 *   - HTTP 404 (exact miss — unknown app or unknown version_code)
 *   - Any non-200 response
 *   - Network errors
 */
export async function fetchMapJson(
    app: string,
    version_code: number,
    config: PullConfig,
): Promise<string> {
    const url = buildMapUrl(app, version_code, config);
    let response: Awaited<ReturnType<PullConfig['fetch']>>;
    try {
        response = await config.fetch(url);
    } catch (err) {
        throw new RosettaError(
            `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (response.status === 404) {
        throw new RosettaError(
            `no map found for ${app}@${version_code} in the rosetta-maps repo ` +
                `(HTTP 404 at ${url}). ` +
                `Check that the app name and version_code are correct, or contribute a map at ` +
                `https://github.com/Xiddoc/rosetta-maps`,
        );
    }
    if (!response.ok) {
        throw new RosettaError(`unexpected HTTP ${response.status} fetching ${url}`);
    }
    return response.text();
}

/**
 * Core of `rosetta pull`: fetch + validate + write the map. Returns the
 * output path. Kept separate from the I/O-printing `runPull` wrapper so it
 * can be unit-tested by its return value.
 *
 * @throws RosettaError for any handled failure (exact-miss, validation, I/O).
 */
export async function writePulledMap(
    argv: readonly string[],
    fs: FsLike,
    config: PullConfig,
): Promise<string> {
    const opts = parsePullArgs(argv);
    assertValidApp(opts.app);

    const outPath = opts.output ?? defaultMapPath(opts.app, opts.version_code);
    if (opts.output !== undefined) {
        assertNoNul(outPath);
    } else {
        assertContained(outPath);
    }

    // Fetch the raw JSON from the remote repo.
    const raw = await fetchMapJson(opts.app, opts.version_code, config);

    // Parse and validate against the schema — fail loudly on a bad map.
    let parsed: unknown;
    try {
        parsed = parseJson(raw);
    } catch (e) {
        throw new RosettaError(
            `fetched content for ${opts.app}@${opts.version_code} is not valid JSON: ${(e as Error).message}`,
        );
    }
    const validated = validateStructure(parsed);

    // Re-render to canonical form (4-space indent + trailing newline) so the
    // written artifact is byte-for-byte identical to what `rosetta convert`
    // would produce — no accidental whitespace drift.
    const canonical = renderJson(validated);

    await writeNew(fs, outPath, canonical, { force: opts.force });
    return outPath;
}

/**
 * Execute `rosetta pull` under the shared command contract: fetch + validate
 * + write the map and return the success message.
 */
export async function runPull(
    argv: readonly string[],
    io: CommandIo,
    config: PullConfig,
): Promise<string> {
    const out = await writePulledMap(argv, io.fs, config);
    return `wrote ${out}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default output path: `maps/<app>/<version_code>.json`. */
export function defaultMapPath(app: string, version_code: number): string {
    return path.join('maps', app, `${version_code}.json`);
}
