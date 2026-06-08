/**
 * `rosetta diff <from> <to>` — structural diff between two maps.
 *
 * Thin CLI wrapper: arg-parse + IO + call. The pure diff engine lives in
 * `src/diff/` ({@link diffMaps} / {@link renderHumanDiff}) and is re-exported
 * from the package root, so the diff is usable programmatically (library-first
 * parity with `convert`). This file only loads both maps through the same
 * {@link loadMap} path `validate` uses (format auto-detected by extension),
 * computes the diff, and renders it.
 *
 * Output:
 *   - Human-readable by default: grouped, greppable lines.
 *   - `--json`: a machine-readable {@link MapDiff} object on stdout.
 *   - `--exit-code`: opt-in CI mode — exit non-zero (1) when the diff is
 *     non-empty (the map rotated), while the report still goes to stdout.
 *     Default exit stays 0 regardless of diff content.
 *
 * Read-only: never writes a file. It is a reporting verb, not a deobfuscator.
 */

import { RosettaError } from '../../src/errors.js';
import { diffMaps, renderHumanDiff, isNoChange } from '../../src/diff/diff.js';
import type { MapDiff } from '../../src/diff/diff.js';
import { DiffDriftError, type CommandIo, type FsLike } from './io.js';
import { loadMap } from './validate.js';
import { parseArgs, type ArgSpec } from './args.js';

// Re-export the diff core through the command module too, so existing callers
// and tests that import from here keep working.
export { diffMaps, renderHumanDiff } from '../../src/diff/diff.js';
export type { MapDiff, ClassDelta, ObfChange, SignatureChange } from '../../src/diff/diff.js';

/** Parsed argument shape for `diff`. */
export interface DiffOptions {
    /** The "from" (old / left) map path. */
    fromPath: string;
    /** The "to" (new / right) map path. */
    toPath: string;
    /** Emit machine-readable JSON instead of the human report. */
    json: boolean;
    /** Exit non-zero (1) when the diff is non-empty (CI drift gate). */
    exitCode: boolean;
}

/** Option grammar for `diff`: two positionals + `--json` + `--exit-code`. */
const DIFF_SPEC: ArgSpec = {
    options: [
        { name: 'json', aliases: ['--json'], takesValue: false },
        { name: 'exitCode', aliases: ['--exit-code'], takesValue: false },
    ],
};

/** Parse argv → DiffOptions. */
export function parseDiffArgs(argv: readonly string[]): DiffOptions {
    const { positionals, flags } = parseArgs(argv, DIFF_SPEC);
    if (positionals.length !== 2) {
        throw new RosettaError(
            `diff requires exactly two positional args: <from> <to> (got ${positionals.length})`,
        );
    }
    return {
        fromPath: positionals[0] as string,
        toPath: positionals[1] as string,
        json: flags.json ?? false,
        exitCode: flags.exitCode ?? false,
    };
}

/**
 * Execute `rosetta diff` under the shared command contract: load both maps,
 * compute the diff, and return the report (human or `--json`). The router
 * prints it under the uniform `rosetta diff:` prefix.
 *
 * With `--exit-code`, a non-empty diff throws {@link DiffDriftError} carrying
 * the rendered report; the router prints that report to stdout (no error
 * prefix — it is the requested output, not a failure) and exits 1.
 */
export async function runDiff(argv: readonly string[], io: CommandIo): Promise<string> {
    const opts = parseDiffArgs(argv);
    const fs: FsLike = io.fs;
    const from = await loadMap(opts.fromPath, fs);
    const to = await loadMap(opts.toPath, fs);
    if (from.app !== to.app) {
        throw new RosettaError(`cannot diff maps for different apps: ${from.app} vs ${to.app}`);
    }
    const diff: MapDiff = diffMaps(from, to);
    const report = opts.json ? JSON.stringify(diff, null, 2) : renderHumanDiff(diff);
    if (opts.exitCode && !isNoChange(diff)) {
        throw new DiffDriftError(report);
    }
    return report;
}
