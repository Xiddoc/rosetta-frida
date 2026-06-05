/**
 * `rosetta convert <in> -o <out.json>`
 *
 * Auto-detects the input format by extension and writes canonical
 * strict JSON to the output path.
 *
 * Recognized inputs:
 *   - `.yaml` / `.yml`         → YAML source.
 *
 * JSON input (`.json`) is rejected here: it's already in the canonical
 * format, so there's nothing to convert. TS/JS-module inputs
 * (`.ts`/`.js`/`.mjs`/`.cjs`) are refused — maps are pure data and must
 * be authored as JSON or YAML (module ingestion was a build-time RCE).
 *
 * The output path is checked for NUL bytes only; operator-supplied `-o`
 * may point anywhere (e.g. `/tmp/out.json`). Content-derived paths (such
 * as `rosetta init`'s default) are separately contained to the project tree.
 */

import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { convertToJson, yamlToMap, refuseModuleInput } from '../../src/convert/index.js';
import { assertNoNul } from '../../src/parse/index.js';
import type { CommandIo, FsLike } from './io.js';
import { ensureDir, writeNew } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

export interface ConvertOptions {
    inputPath: string;
    outputPath: string;
    /** Overwrite existing output. */
    force?: boolean;
}

/** Option grammar for `convert`: `-o/--output <path>` and `--force/-f`. */
const CONVERT_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
    ],
};

/** Parse argv → ConvertOptions. */
export function parseConvertArgs(argv: readonly string[]): ConvertOptions {
    const { positionals, values, flags } = parseArgs(argv, CONVERT_SPEC);
    if (positionals.length !== 1) {
        throw new RosettaError(
            `convert requires exactly one positional arg: <in> (got ${positionals.length})`,
        );
    }
    if (values.output === undefined) {
        throw new RosettaError('convert requires -o <out.json>');
    }
    return {
        inputPath: positionals[0] as string,
        outputPath: values.output,
        force: flags.force ?? false,
    };
}

/**
 * Core of `rosetta convert`: render the input to canonical JSON and write
 * it, returning the output path. Separated from the I/O-printing
 * `runConvert` wrapper so it stays unit-testable by return value.
 */
export async function convertFile(argv: readonly string[], fs: FsLike): Promise<string> {
    const opts = parseConvertArgs(argv);
    assertNoNul(opts.inputPath);
    // Reject NUL in the output path. Containment to the project tree is NOT
    // applied: operator-supplied -o may legitimately point outside CWD (e.g.
    // /tmp/out.json). Content-derived paths (rosetta init default) are
    // contained there.
    assertNoNul(opts.outputPath);
    const ext = path.extname(opts.inputPath).toLowerCase();

    let json: string;
    if (ext === '.yaml' || ext === '.yml') {
        const raw = await fs.readFile(opts.inputPath, 'utf8');
        json = await convertToJson(raw, 'yaml');
    } else if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        // Maps are pure data — never import a contributor-supplied module.
        refuseModuleInput(opts.inputPath);
    } else if (ext === '.json') {
        throw new RosettaError(`input is already in canonical format (${ext}); nothing to convert`);
    } else {
        throw new RosettaError(`unsupported input format: ${ext} (path: ${opts.inputPath})`);
    }

    await ensureDir(fs, path.dirname(opts.outputPath));
    // writeNew is the single overwrite guard: atomic `wx` create unless
    // --force, closing the stat-then-write TOCTOU window.
    await writeNew(fs, opts.outputPath, json, { force: opts.force });
    return opts.outputPath;
}

/**
 * Execute `rosetta convert` under the shared command contract: convert,
 * report the written path to stdout, and return exit code 0. Handled
 * failures throw `RosettaError` for the router to format.
 */
export async function runConvert(argv: readonly string[], io: CommandIo): Promise<number> {
    const out = await convertFile(argv, io.fs);
    io.stdout(`wrote ${out}`);
    return 0;
}

// Re-export for tests that want to round-trip through the same entry that the
// CLI itself goes through.
export { yamlToMap };
