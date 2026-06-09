/**
 * `rosetta freshness <map...> --signatures <signatures.yaml> [--json]`
 *
 * The zero-toolchain, read-only consumer twin of the maps-side
 * `scripts/check_map_freshness.py` CI check (maps#34). It tells you which of
 * your *vendored* `<app>/<version_code>.json` maps have fallen behind the
 * current signatures — i.e. omit a class that a signature rule now defines —
 * so you know which to regenerate.
 *
 * Thin CLI wrapper: arg-parse + IO + call. The pure freshness engine lives in
 * `src/freshness/` ({@link analyseFreshness}) and is re-exported from the
 * package root for programmatic use (library-first parity with `diff` /
 * `merge`). This file resolves the inputs, reads them through the injected
 * `fs`, runs the shared algorithm, and renders the report.
 *
 * ADVISORY CONTRACT (identical to the maps-side check): a STALE map is normal
 * and never an error — `freshness` returns its report and the router exits 0.
 * A non-zero exit is reserved EXCLUSIVELY for the verb's OWN malformed inputs
 * (unreadable/garbled signatures YAML or map JSON, a wrong-shaped doc), which
 * surface as a thrown {@link FreshnessInputError} the router renders under the
 * uniform `rosetta freshness:` prefix and maps to exit 1.
 *
 * It does NOT require an APK and does NO network I/O — it reads only the map
 * files and the signatures file you point it at.
 *
 * Maps are passed as positional paths; expand a directory/glob at the shell
 * (`rosetta freshness maps/**\/*.json --signatures signatures/<app>/signatures.yaml`).
 * Each map's `app` is its parent directory name and its `version_code` is the
 * filename without extension, matching the maps-repo `maps/<app>/<vc>.json`
 * layout and the Python check's `_app_of` / version-code derivation.
 */

import { basename, dirname, extname } from 'node:path';
import { RosettaError } from '../../src/errors.js';
import {
    analyse,
    parseSignatures,
    parseMapClassKeys,
    renderReport,
    type MapClassKeys,
} from '../../src/freshness/index.js';
import { assertNoNul } from '../../src/parse/index.js';
import type { CommandIo, FsLike } from './io.js';
import { errorMessage } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

// Re-export the freshness core through the command module too, so callers and
// tests importing from here keep working (parity with merge/diff wrappers).
export {
    analyse,
    parseSignatures,
    parseMapClassKeys,
    renderReport,
    FreshnessInputError,
} from '../../src/freshness/index.js';
export type { FreshnessFinding, FreshnessReport, MapClassKeys } from '../../src/freshness/index.js';

/** Parsed argument shape for `freshness`. */
export interface FreshnessOptions {
    /** The vendored map paths to check (shell-globbed positionals). */
    mapPaths: string[];
    /** Path to the `signatures.yaml` source of truth. */
    signaturesPath: string;
    /** Emit the structured findings as JSON instead of the human report. */
    json: boolean;
}

/** Option grammar: N positional maps + `--signatures <path>` + `--json`. */
const FRESHNESS_SPEC: ArgSpec = {
    options: [
        { name: 'signatures', aliases: ['--signatures', '-s'], takesValue: true },
        { name: 'json', aliases: ['--json'], takesValue: false },
    ],
};

/** Parse argv → FreshnessOptions. */
export function parseFreshnessArgs(argv: readonly string[]): FreshnessOptions {
    const { positionals, values, flags } = parseArgs(argv, FRESHNESS_SPEC);
    if (positionals.length < 1) {
        throw new RosettaError(
            `freshness requires at least one map path (got ${positionals.length}); ` +
                'expand a glob at the shell, e.g. maps/**/*.json',
        );
    }
    if (values.signatures === undefined) {
        throw new RosettaError('freshness requires --signatures <signatures.yaml>');
    }
    return {
        mapPaths: positionals,
        signaturesPath: values.signatures,
        json: flags.json ?? false,
    };
}

/** The app a `maps/<app>/<version_code>.json` path belongs to. */
function appOf(mapPath: string): string {
    return basename(dirname(mapPath));
}

/** The version_code a map path encodes (its filename without extension). */
function versionCodeOf(mapPath: string): string {
    return basename(mapPath, extname(mapPath));
}

/**
 * Read a file through the injected fs, wrapping a read failure (e.g. ENOENT)
 * into the uniform `cannot read <file>: …` message the other file-reading
 * verbs use. A read failure is a malformed/unusable input → non-zero exit.
 */
async function readInput(path: string, fs: FsLike): Promise<string> {
    assertNoNul(path);
    try {
        return await fs.readFile(path, 'utf8');
    } catch (err) {
        throw new RosettaError(`cannot read ${path}: ${errorMessage(err)}`);
    }
}

/**
 * Core of `rosetta freshness`: read the signatures + every map through the
 * injected fs, run the shared analysis, and return the rendered report.
 * Separated from the printing wrapper so it stays unit-testable by return
 * value. Throws `FreshnessInputError` / `RosettaError` on a malformed or
 * unreadable input; a staleness finding is part of the returned report, not an
 * error.
 */
export async function freshnessReport(argv: readonly string[], fs: FsLike): Promise<string> {
    const opts = parseFreshnessArgs(argv);

    // The signatures file's app is its parent directory name, mirroring the
    // maps-repo `signatures/<app>/signatures.yaml` layout and the Python
    // check's `_app_of`. Only maps for this app get an expectation set.
    const sigApp = appOf(opts.signaturesPath);
    const sigSource = await readInput(opts.signaturesPath, fs);
    const sigByApp = new Map<string, Set<string>>([
        [sigApp, parseSignatures(sigSource, opts.signaturesPath)],
    ]);

    const maps: MapClassKeys[] = [];
    for (const mapPath of opts.mapPaths) {
        const source = await readInput(mapPath, fs);
        maps.push({
            mapPath,
            app: appOf(mapPath),
            versionCode: versionCodeOf(mapPath),
            classKeys: parseMapClassKeys(source, mapPath),
        });
    }

    const report = analyse(maps, sigByApp);
    return opts.json ? JSON.stringify(report.findings, null, 2) : renderReport(report);
}

/**
 * Execute `rosetta freshness` under the shared command contract: analyse the
 * vendored maps against the signatures and return the report as the success
 * message (the router prints it under the uniform `rosetta freshness:`
 * prefix). A stale map is NOT a failure — it is the requested output and the
 * router exits 0; only a malformed input throws (exit 1).
 */
export async function runFreshness(argv: readonly string[], io: CommandIo): Promise<string> {
    return freshnessReport(argv, io.fs);
}
