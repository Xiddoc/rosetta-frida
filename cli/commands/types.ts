/**
 * `rosetta types <map> -o <out.d.ts>` — emit a TypeScript declaration stub
 * for a map's REAL names.
 *
 * Thin CLI wrapper: arg-parse + IO + call. The pure renderer lives in
 * `src/types-emit/` ({@link renderTypes} / {@link collectNames}) and is
 * re-exported from the package root for programmatic use (library-first parity
 * with `convert`). This file only loads the map, renders the stub, and writes
 * it.
 *
 * The emitted module declares string-literal unions of the map's real class /
 * method / field names so an editor can offer autocompletion and a build can
 * flag a stale name. Purely derived from the map's KEYS — never obfuscated
 * names (those rotate), never an APK. Output is deterministic.
 */

import { RosettaError } from '../../src/errors.js';
import { renderTypes } from '../../src/types-emit/emit.js';
import type { CommandIo, FsLike } from './io.js';
import { writeNew } from './io.js';
import { loadMap } from './validate.js';
import { parseArgs, type ArgSpec } from './args.js';

// Re-export the emit core through the command module too, so existing callers
// and tests that import from here keep working.
export { renderTypes, collectNames } from '../../src/types-emit/emit.js';
export type { ClassNames } from '../../src/types-emit/emit.js';

/** Parsed argument shape for `types`. */
export interface TypesOptions {
    /** Input map path. */
    inputPath: string;
    /** Where to write the `.d.ts` stub. */
    outputPath: string;
    /** Overwrite an existing output file. */
    force: boolean;
}

/** Option grammar for `types`: one positional + `-o`, `--force`. */
const TYPES_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
    ],
};

/** Parse argv → TypesOptions. */
export function parseTypesArgs(argv: readonly string[]): TypesOptions {
    const { positionals, values, flags } = parseArgs(argv, TYPES_SPEC);
    if (positionals.length !== 1) {
        throw new RosettaError(
            `types requires exactly one positional arg: <map> (got ${positionals.length})`,
        );
    }
    if (values.output === undefined) {
        throw new RosettaError('types requires -o <out.d.ts>');
    }
    return {
        inputPath: positionals[0] as string,
        outputPath: values.output,
        force: flags.force ?? false,
    };
}

/**
 * Core of `rosetta types`: load the map, render the stub, write it. Returns
 * the output path. Separated from the printing wrapper for unit testing.
 */
export async function typesFile(argv: readonly string[], fs: FsLike): Promise<string> {
    const opts = parseTypesArgs(argv);
    const map = await loadMap(opts.inputPath, fs);
    await writeNew(fs, opts.outputPath, renderTypes(map), { force: opts.force });
    return opts.outputPath;
}

/**
 * Execute `rosetta types` under the shared command contract: render the
 * `.d.ts` and return the success message.
 */
export async function runTypes(argv: readonly string[], io: CommandIo): Promise<string> {
    const out = await typesFile(argv, io.fs);
    return `wrote ${out}`;
}
