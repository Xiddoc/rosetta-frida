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
 * **Sidecar transport-integrity verification.** Alongside each map the
 * rosetta-maps repo publishes a detached `<version_code>.json.sha256`
 * sidecar (coreutils `sha256sum` format). When present it is fetched and
 * the SHA-256 of the EXACT raw fetched map bytes is checked against it
 * BEFORE the body is parsed or trusted — a transport-integrity tier (not
 * publisher authenticity; that is the separate `signer_sha256` guard). The
 * parse rule is byte-for-byte the rosetta-maps owner contract (single source
 * of truth: rosetta-maps `docs/reference/integrity.md`): one line only (a
 * multi-line / multi-entry sidecar FAILS CLOSED), first whitespace token =
 * digest, optional second token = the map basename which (when present) MUST
 * equal `<version_code>.json` else FAILS CLOSED. A digest mismatch, malformed
 * sidecar, or basename mismatch all FAIL CLOSED. A missing sidecar (HTTP 404)
 * warns and proceeds during rollout, unless `--require-sidecar` (or
 * {@link PullConfig.requireSidecar}) opts into strict fail-closed mode.
 *
 * Refuses to overwrite an existing map unless `--force` is passed.
 */

import { createHash } from 'node:crypto';
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

/**
 * Hard upper bound on a fetched `.sha256` sidecar body, in bytes. A
 * well-formed sidecar is a single short line — a 64-hex digest, two spaces,
 * and a bare filename — well under 256 bytes. The cap is the same
 * denial-of-service guard as {@link MAX_MAP_BYTES}, sized tightly because a
 * sidecar can never legitimately be large; a hostile endpoint must not be
 * able to stream an unbounded body in place of a one-line digest. 4 KiB
 * leaves head-room for a generous filename while bounding the worst case.
 */
export const MAX_SIDECAR_BYTES = 4 * 1024;

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
    /**
     * Strict sidecar policy. When `true`, a map whose detached
     * `.json.sha256` sidecar is ABSENT (HTTP 404) is rejected fail-closed
     * instead of the default warn-and-proceed. A sidecar that is PRESENT is
     * always verified and a mismatch/malformed sidecar always fails closed,
     * regardless of this flag.
     *
     * Default `false` during the rollout (an unmigrated map without a
     * sidecar still pulls, with a warning). Exposed on the CLI as
     * `--require-sidecar`. Kept on the typed config (never a `process.env`
     * lookup) per the project's typed-config rule.
     */
    requireSidecar: boolean;
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
        requireSidecar: false,
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
    /**
     * Strict sidecar mode: when `true`, an ABSENT `.json.sha256` sidecar is
     * a hard error instead of a warn-and-proceed. Set by `--require-sidecar`
     * and OR-ed with {@link PullConfig.requireSidecar}. Always populated by
     * {@link parsePullArgs} (default `false`).
     */
    requireSidecar: boolean;
}

/**
 * Option grammar for `pull`: `-o/--output <path>`, `--force/-f`, and
 * `--require-sidecar` (strict sidecar mode).
 */
const PULL_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
        { name: 'requireSidecar', aliases: ['--require-sidecar'], takesValue: false },
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
        requireSidecar: flags.requireSidecar ?? false,
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
 * Returns BOTH the fetched body AND the exact URL it was fetched from, so the
 * caller derives the sidecar URL from the EXACT fetched URL rather than
 * re-deriving it with a second {@link buildMapUrl} call (one logical URL, one
 * derivation).
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
): Promise<{ url: string; body: string }> {
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
    return { url, body };
}

// ---------------------------------------------------------------------------
// Sidecar (transport-integrity) verification
// ---------------------------------------------------------------------------

/** A lowercase 64-hex SHA-256 digest, as it appears in a sidecar's first token. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Verify a detached `.json.sha256` sidecar against the EXACT raw map bytes.
 *
 * The sidecar is coreutils `sha256sum` format — one line, `<digest>␠␠<name>`
 * — so the first whitespace-delimited token is the expected digest and an
 * optional second token is the map basename. This is a TRANSPORT-INTEGRITY
 * check (did the bytes arrive intact / un-tampered), NOT a
 * publisher-authenticity one (that is the separate `signer_sha256` guard
 * inside the map).
 *
 * Algorithm — the authoritative cross-client contract, byte-for-byte
 * identical to the rosetta-maps owner-side `verify_sidecar` and the
 * rosetta-xposed Gradle client (the single source of truth is the
 * rosetta-maps `docs/reference/integrity.md`):
 *   1. Split the text on `\n` and take the first line; a single optional
 *      trailing `\n` is allowed and a trailing `\r` (CRLF) is tolerated as
 *      whitespace. Any SUBSEQUENT non-empty line FAILS CLOSED — a sidecar is
 *      exactly one line (multi-entry coreutils files are out of scope).
 *   2. Split that first line on ASCII whitespace (tolerating leading/trailing
 *      whitespace and single-space / multiple-space / tab separators). The
 *      first token is the expected digest; lowercase it. No tokens → FAIL.
 *   3. Reject unless the digest matches `^[0-9a-f]{64}$`.
 *   4. If a SECOND token (the basename) is present it MUST equal the map
 *      file's basename (`<version_code>.json`), else FAIL CLOSED (catches a
 *      misfiled / copy-pasted sidecar). An absent basename token is allowed.
 *   5. Hash the EXACT raw fetched map bytes (the body received over the wire,
 *      BEFORE any re-render/canonicalization). Plain lowercase-hex equality;
 *      mismatch FAILS CLOSED.
 *
 * @param rawMapBytes the exact map body as fetched (pre-canonicalization).
 * @param sidecarText the sidecar file's UTF-8 text.
 * @param mapBasename the map file's bare basename (`<version_code>.json`); a
 *   present basename token must equal it.
 * @returns `{ ok: true }` on a match.
 * @throws RosettaError on a malformed/multi-line sidecar, a basename
 *   mismatch, or a digest mismatch.
 */
export function verifySidecar(
    rawMapBytes: string,
    sidecarText: string,
    mapBasename: string,
): { ok: true } {
    // Only the first line is significant; a single optional trailing newline is
    // allowed. Any further NON-EMPTY line makes the sidecar malformed (a
    // single-map sidecar is exactly one line; multi-entry coreutils files are
    // out of scope). `String.split('\n')` always yields a non-empty array, so
    // `[0]` is always present (the `!` reflects that under
    // `noUncheckedIndexedAccess`).
    const lines = sidecarText.split('\n');
    if (lines.slice(1).some((rest) => rest.trim() !== '')) {
        throw new RosettaError(
            `malformed .sha256 sidecar: expected exactly one line but found extra ` +
                `non-empty content. A single-map sidecar is one line; multi-entry ` +
                `coreutils files are out of scope. Refusing to trust the fetched bytes.`,
        );
    }
    // Tokenize the first line on ASCII whitespace (a trailing `\r` from a CRLF
    // ending is whitespace and is dropped). `.trim()` first so leading
    // whitespace doesn't yield an empty leading token.
    const tokens = lines[0]!
        .trim()
        .split(/\s+/)
        .filter((t) => t !== '');
    if (tokens.length === 0) {
        throw new RosettaError(
            `malformed .sha256 sidecar: expected a 64-hex SHA-256 digest as the ` +
                `first token but the sidecar is empty. Refusing to trust the fetched ` +
                `bytes (transport-integrity check failed).`,
        );
    }
    const expected = tokens[0]!.toLowerCase();
    if (!SHA256_HEX_RE.test(expected)) {
        throw new RosettaError(
            `malformed .sha256 sidecar: expected a 64-hex SHA-256 digest as the ` +
                `first token but got '${expected}'. Refusing to trust the fetched ` +
                `bytes (transport-integrity check failed).`,
        );
    }
    // A present basename token must equal the map's basename (fail closed on a
    // misfiled / copy-pasted sidecar). An absent token is allowed.
    const basename = tokens[1];
    if (basename !== undefined && basename !== mapBasename) {
        throw new RosettaError(
            `.sha256 sidecar basename mismatch: the sidecar names '${basename}' but ` +
                `it sits beside '${mapBasename}'. Refusing to trust a misfiled or ` +
                `copy-pasted sidecar (fail-closed transport integrity).`,
        );
    }
    const actual = createHash('sha256').update(rawMapBytes, 'utf8').digest('hex');
    if (actual !== expected) {
        throw new RosettaError(
            `.sha256 sidecar mismatch: the fetched map bytes do not match the ` +
                `published digest. Expected ${expected} but computed ${actual}. ` +
                `Refusing to write tampered or corrupted bytes (fail-closed transport ` +
                `integrity).`,
        );
    }
    return { ok: true };
}

/**
 * Fetch the detached `.json.sha256` sidecar for a map URL.
 *
 * The sidecar path is the map URL plus the `.sha256` suffix. Returns the
 * sidecar's text when present, or `null` on HTTP 404 (absent — the caller
 * decides warn-vs-fail per the rollout policy). Any other non-200 status,
 * an oversize body, or a network error is a hard error.
 *
 * @throws RosettaError on a non-200/non-404 status, an oversize body, or a
 *   network failure.
 */
export async function fetchSidecar(mapUrl: string, config: PullConfig): Promise<string | null> {
    const url = `${mapUrl}.sha256`;
    let response: Awaited<ReturnType<PullConfig['fetch']>>;
    try {
        response = await config.fetch(url);
    } catch (err) {
        throw new RosettaError(
            `network error fetching sidecar ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    // Absent sidecar — let the caller apply the rollout (warn vs. require) policy.
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new RosettaError(`unexpected HTTP ${response.status} fetching sidecar ${url}`);
    }

    // Cheap pre-check against the advertised length, then the authoritative
    // decoded-length bound — same two-tier guard as the map body.
    const declared = response.headers?.get('content-length');
    if (declared !== null && declared !== undefined) {
        const declaredBytes = Number(declared);
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SIDECAR_BYTES) {
            throw new RosettaError(
                `sidecar at ${url} is too large: Content-Length ${declaredBytes} bytes ` +
                    `exceeds the ${MAX_SIDECAR_BYTES}-byte limit`,
            );
        }
    }
    const body = await response.text();
    if (body.length > MAX_SIDECAR_BYTES) {
        throw new RosettaError(
            `sidecar at ${url} is too large: ${body.length} bytes exceeds the ` +
                `${MAX_SIDECAR_BYTES}-byte limit`,
        );
    }
    return body;
}

/**
 * Apply the sidecar transport-integrity ROLLOUT POLICY to the raw fetched map
 * bytes. This is the POLICY layer (it fetches the sidecar and may proceed
 * WITHOUT verifying when one is absent in non-strict mode) — the pure check is
 * {@link verifySidecar}.
 *
 * Rollout policy (mirrors the rosetta-maps "optional during rollout"
 * stance):
 *   - sidecar PRESENT + MATCHES → proceed.
 *   - sidecar PRESENT + MISMATCH/MALFORMED/BASENAME-MISMATCH → FAIL CLOSED
 *     (via {@link verifySidecar}).
 *   - sidecar ABSENT (404) + non-strict → emit one WARNING, proceed.
 *   - sidecar ABSENT (404) + strict (`requireSidecar`) → FAIL CLOSED.
 *
 * @param mapUrl the EXACT URL the map was fetched from; the sidecar URL is
 *   this plus `.sha256`.
 * @param mapBasename the map's bare basename (`<version_code>.json`), threaded
 *   to {@link verifySidecar} for the basename-token check.
 * @param requireSidecar strict toggle: when `true`, an absent sidecar fails
 *   closed instead of warn-and-proceed (computed once at the call site as the
 *   OR of the CLI flag and the config field).
 * @throws RosettaError on a verification failure or a missing sidecar in
 *   strict mode.
 */
async function applySidecarPolicy(
    mapUrl: string,
    mapBasename: string,
    rawMapBytes: string,
    requireSidecar: boolean,
    config: PullConfig,
    warn?: Writer,
): Promise<void> {
    const sidecar = await fetchSidecar(mapUrl, config);
    if (sidecar === null) {
        if (requireSidecar) {
            throw new RosettaError(
                `no .sha256 sidecar found for ${mapUrl} (HTTP 404) and --require-sidecar ` +
                    `is set: refusing to write unverified bytes. Either drop --require-sidecar ` +
                    `to proceed without transport-integrity verification, or contribute the ` +
                    `missing sidecar to the rosetta-maps repo.`,
            );
        }
        warn?.(
            `warning: no .sha256 sidecar found for ${mapUrl} (HTTP 404) — proceeding ` +
                `WITHOUT transport-integrity verification. Pass --require-sidecar to fail ` +
                `closed on a missing sidecar.`,
        );
        return;
    }
    // Present: verify against the EXACT raw bytes (mismatch/malformed/basename
    // mismatch throws).
    verifySidecar(rawMapBytes, sidecar, mapBasename);
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

    // Fetch the raw JSON from the remote repo. `fetchMapJson` returns the exact
    // URL it fetched from so the sidecar URL is derived from that one URL (not
    // re-derived with a second `buildMapUrl` call).
    const { url: mapUrl, body: raw } = await fetchMapJson(opts.app, opts.version_code, config);

    // Transport-integrity gate: verify the detached `.sha256` sidecar against
    // the EXACT raw fetched bytes BEFORE they are parsed/trusted/written, so
    // tampered or corrupted bytes are rejected as early as possible. The strict
    // toggle is the OR of the CLI flag and the typed config field, computed
    // once here. The basename token (when the sidecar carries one) must equal
    // the map's `<version_code>.json` filename.
    const requireSidecar = config.requireSidecar || opts.requireSidecar;
    await applySidecarPolicy(
        mapUrl,
        `${opts.version_code}.json`,
        raw,
        requireSidecar,
        config,
        warn,
    );

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
