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
 * Source URL and pinned ref flow through {@link PullConfig} (Zod-validated
 * before use) so they are auditable and testable without `process.env`
 * lookups scattered around. An unpinned ref warns; the fetched body is
 * bounded to {@link MAX_MAP_BYTES}.
 *
 * After schema validation the fetched map's OWN `app`/`version_code` are
 * cross-checked against the requested pair, so a mismatched upstream file
 * can never be written under the wrong name (it would otherwise silently
 * bind the wrong version at runtime).
 *
 * Exact-miss (unknown app or unknown version_code in the remote repo)
 * fails loudly with an actionable message — a wrong map is worse than no
 * map, so silent fall-backs are explicitly rejected.
 *
 * Refuses to overwrite an existing map unless `--force` is passed.
 */

import { z } from 'zod';
import { RosettaError } from '../../src/errors.js';
import { validateStructure } from '../../src/convert/index.js';
import { parseJson } from '../../src/parse/json.js';
import {
    assertValidApp,
    assertContained,
    assertNoNul,
    defaultMapPath,
} from '../../src/parse/index.js';
import { renderJson } from '../../src/convert/json.js';
import type { CommandIo, FsLike, Writer } from './io.js';
import { writeNew } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

// ---------------------------------------------------------------------------
// Typed configuration — source URL/ref must NOT be process.env lookups.
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on a fetched map body, in bytes. A community map is a
 * small JSON document (the worked example is a few KB; even a large,
 * many-class map is well under a megabyte). The cap is a denial-of-service
 * guard: a hostile or misconfigured endpoint must not be able to stream an
 * unbounded body into memory before we ever parse it. 5 MiB leaves ample
 * head-room for legitimate maps while bounding the worst case. Enforced
 * against both the advertised `Content-Length` (cheap pre-check) and the
 * actual decoded text length (the authoritative check, since the header is
 * advisory and may be absent or lie).
 */
export const MAX_MAP_BYTES = 5 * 1024 * 1024;

/** The HTTP response shape the fetch seam must provide. */
export interface PullResponse {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    /**
     * WHATWG `Headers`-like accessor for the response headers. Optional so
     * a minimal test double can omit it; when present it is consulted for a
     * cheap `Content-Length` pre-check before the body is read.
     */
    headers?: { get(name: string): string | null };
}

/**
 * Typed configuration for `rosetta pull`. All network / repo coordinates
 * live here rather than in scattered `process.env` lookups (see the
 * project's typed-config rule). The effective config is Zod-validated by
 * {@link assertValidPullConfig} before any fetch.
 *
 * The defaults point to the canonical rosetta-maps GitHub repository.
 * Override in tests to avoid real network calls.
 */
export interface PullConfig {
    /**
     * Base raw-content URL for the rosetta-maps repo. Must be a valid URL
     * and must NOT end with `/` (the URL builder joins path segments with
     * `/`, so a trailing slash would produce a `//`).
     *
     * Default: `https://raw.githubusercontent.com/Xiddoc/rosetta-maps`
     */
    mapsRepoBaseUrl: string;
    /**
     * Git ref (branch, tag, or full SHA) to fetch maps from. Must be
     * non-empty.
     *
     * PINNING IS RECOMMENDED. A full 40-hex SHA (or an immutable `vX.Y.Z`
     * tag) gives **reproducible** build-time bundling: the same `pull`
     * always fetches byte-identical bytes. A moving branch like `main`
     * resolves to whatever the latest contribution is, so a later re-pull
     * can silently bundle a different map. {@link assertValidPullConfig}
     * (via `runPull`) emits a WARNING when the ref looks unpinned.
     *
     * Default: `main` (configurable; pin it for reproducible builds).
     */
    mapsRepoRef: string;
    /**
     * HTTP fetch seam — injected so tests can mock it without hitting the
     * real network. Must have the same signature as the WHATWG `fetch`
     * global. The fetched body is bounded to {@link MAX_MAP_BYTES}.
     */
    fetch: (url: string) => Promise<PullResponse>;
}

/**
 * Zod schema for the *coordinates* in {@link PullConfig} (the `fetch` seam
 * is a function and not data-validated here). Centralising validation keeps
 * the config surface auditable per the typed-config rule.
 */
const PULL_CONFIG_SCHEMA = z.object({
    mapsRepoBaseUrl: z
        .string()
        .url('mapsRepoBaseUrl must be a valid URL')
        .refine((u) => !u.endsWith('/'), 'mapsRepoBaseUrl must not end with a trailing slash'),
    mapsRepoRef: z.string().min(1, 'mapsRepoRef must be a non-empty git ref'),
});

/** A full 40-character hex commit SHA. */
const SHA_RE = /^[0-9a-f]{40}$/;
/** An immutable release tag like `v1.2.3` (optionally with a suffix). */
const TAG_RE = /^v\d+\.\d+\.\d+/;

/** Whether a ref is a reproducible pin (full SHA or `vX.Y.Z` tag). */
export function isPinnedRef(ref: string): boolean {
    return SHA_RE.test(ref) || TAG_RE.test(ref);
}

/**
 * Validate the config coordinates and warn on an unpinned ref. Throws a
 * {@link RosettaError} on a malformed base URL or empty ref; emits a single
 * WARNING line via `warn` (when provided) for a moving ref like `main`.
 */
export function assertValidPullConfig(config: PullConfig, warn?: Writer): void {
    const result = PULL_CONFIG_SCHEMA.safeParse(config);
    if (!result.success) {
        const msg = result.error.issues.map((i) => i.message).join('; ');
        throw new RosettaError(`invalid pull config: ${msg}`);
    }
    if (warn && !isPinnedRef(config.mapsRepoRef)) {
        warn(
            `warning: mapsRepoRef '${config.mapsRepoRef}' is not pinned — pulls are not ` +
                `reproducible. Pin a full 40-hex commit SHA or a 'vX.Y.Z' tag for ` +
                `reproducible build-time bundling.`,
        );
    }
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
    const parts = raw.split('@');
    // Exactly one `@`: a single split yields two parts. Zero `@` (one part)
    // and multiple `@` (3+ parts) are both ambiguous and rejected.
    if (parts.length !== 2) {
        throw new RosettaError(
            `pull target must be <app>@<version_code> with exactly one '@' ` +
                `(e.g. com.example.app@30405); got '${raw}'`,
        );
    }
    const [app, vcRaw] = parts as [string, string];
    if (app === '') {
        throw new RosettaError(
            `pull target must be <app>@<version_code> (e.g. com.example.app@30405); ` +
                `the app name before '@' is empty in '${raw}'`,
        );
    }
    // Strict decimal-digits guard: `Number('1e3')` is 1000 but `1e3` is not a
    // valid version_code token. Require a bare run of ASCII digits.
    if (!/^\d+$/.test(vcRaw)) {
        throw new RosettaError(
            `version_code in '${raw}' must be a positive integer (decimal digits only); got '${vcRaw}'`,
        );
    }
    const version_code = Number(vcRaw);
    if (!Number.isInteger(version_code) || version_code <= 0) {
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

    // Cheap pre-check: if the server advertises an oversize body, bail before
    // reading it. The header is advisory (may be absent or wrong), so the
    // decoded-length check below is the authoritative one.
    const declared = response.headers?.get('content-length');
    if (declared !== null && declared !== undefined) {
        const declaredBytes = Number(declared);
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MAP_BYTES) {
            throw new RosettaError(
                `map at ${url} is too large: Content-Length ${declaredBytes} bytes ` +
                    `exceeds the ${MAX_MAP_BYTES}-byte limit`,
            );
        }
    }

    const body = await response.text();
    // Authoritative bound: a map is JSON, so its byte length is at least its
    // UTF-16 code-unit count; rejecting on `.length` over the cap is a sound
    // (conservative) guard without re-encoding.
    if (body.length > MAX_MAP_BYTES) {
        throw new RosettaError(
            `map at ${url} is too large: ${body.length} bytes exceeds the ` +
                `${MAX_MAP_BYTES}-byte limit`,
        );
    }
    return body;
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
    warn?: Writer,
): Promise<string> {
    const opts = parsePullArgs(argv);
    assertValidApp(opts.app);

    // Validate the typed config (and warn on an unpinned ref) before any
    // network I/O, but after arg parsing so a pure misuse (bad target) fails
    // with just its error and isn't preceded by a config warning.
    assertValidPullConfig(config, warn);

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

    // Identity cross-check (REAL BUG fix): the output path is derived from the
    // REQUESTED (app, version_code), but the fetched map carries its OWN
    // `app`/`version_code`. Schema validation alone does not compare them, so a
    // mismatched upstream file (wrong app, or a stale/renamed version) would be
    // written under the requested name and silently bind the WRONG version at
    // runtime. Fail loudly, naming both expected and actual, so the operator
    // never ships a misfiled map.
    if (validated.app !== opts.app || validated.version_code !== opts.version_code) {
        throw new RosettaError(
            `fetched map identity does not match the request: expected ` +
                `${opts.app}@${opts.version_code} but the map declares ` +
                `${validated.app}@${validated.version_code}. ` +
                `Refusing to write a misfiled map.`,
        );
    }

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
    // Route the unpinned-ref warning to stderr so it doesn't pollute the
    // greppable `rosetta pull: …` success line on stdout.
    const out = await writePulledMap(argv, io.fs, config, io.stderr);
    return `wrote ${out}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default output path: `maps/<app>/<version_code>.json`. Re-exported under
 * the local name from the shared {@link defaultMapPath} helper so `init` and
 * `pull` derive the canonical filename from exactly one implementation.
 */
export { defaultMapPath };
