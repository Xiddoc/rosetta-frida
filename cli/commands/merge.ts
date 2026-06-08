/**
 * `rosetta merge <a> <b> [...] -o <out.json>` — combine several partial maps
 * for the SAME `(app, version_code)` into one canonical map.
 *
 * Thin CLI wrapper: arg-parse + IO + call. The pure fold engine lives in
 * `src/merge/` ({@link mergeMaps}, an options-object signature) and is
 * re-exported from the package root for programmatic use (library-first
 * parity with `convert`). This file loads the inputs, folds them, re-validates
 * the result through the canonical schema, and writes the JSON.
 *
 * Inputs are merged LEFT-TO-RIGHT (last-wins). `--strict` turns a conflicting
 * obfuscated name into a hard error. In non-strict mode each last-wins
 * override of an obfuscated name — the "silent wrong name corrupts hooks"
 * hazard — emits an `io.stderr` notice so the operator sees what got
 * overridden. See `src/merge/merge.ts` for the full conflict policy.
 */

import { RosettaError } from '../../src/errors.js';
import { validateStructure } from '../../src/convert/index.js';
import { renderJson } from '../../src/convert/json.js';
import { mergeMaps, type ObfOverride } from '../../src/merge/merge.js';
import type { RosettaMap } from '../../src/types/map.js';
import type { CommandIo, FsLike, Writer } from './io.js';
import { writeNew } from './io.js';
import { loadMap } from './validate.js';
import { parseArgs, type ArgSpec } from './args.js';

// Re-export the merge core through the command module too, so existing callers
// and tests that import from here keep working. (The merge fold's options type
// is `MergeOptions` from `src/merge`; this module's own `MergeOptions` below is
// the distinct CLI arg shape, so only the fold function + override type are
// re-exported here — import the fold options type from the package root.)
export { mergeMaps } from '../../src/merge/merge.js';
export type { ObfOverride } from '../../src/merge/merge.js';

/** Parsed argument shape for `merge`. */
export interface MergeOptions {
    /** The input map paths, in precedence order (last-wins). */
    inputPaths: string[];
    /** Where to write the merged JSON. */
    outputPath: string;
    /** Overwrite an existing output file. */
    force: boolean;
    /** Fail on conflicting obfuscated names rather than last-wins. */
    strict: boolean;
}

/** Option grammar for `merge`: N positionals + `-o`, `--force`, `--strict`. */
const MERGE_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
        { name: 'strict', aliases: ['--strict'], takesValue: false },
    ],
};

/** Parse argv → MergeOptions. */
export function parseMergeArgs(argv: readonly string[]): MergeOptions {
    const { positionals, values, flags } = parseArgs(argv, MERGE_SPEC);
    if (positionals.length < 2) {
        throw new RosettaError(
            `merge requires at least two input maps (got ${positionals.length})`,
        );
    }
    if (values.output === undefined) {
        throw new RosettaError('merge requires -o <out.json>');
    }
    return {
        inputPaths: positionals,
        outputPath: values.output,
        force: flags.force ?? false,
        strict: flags.strict ?? false,
    };
}

/** Format one non-strict obfuscated-name override as a stderr notice line. */
function overrideNotice(o: ObfOverride): string {
    return (
        `note: ${o.kind} '${o.name}' obfuscated name overridden ` +
        `'${o.from}' -> '${o.to}' (last input wins; pass --strict to fail instead)`
    );
}

/**
 * Core of `rosetta merge`: load all inputs, fold them (emitting a stderr
 * notice on each non-strict override), re-validate the result, and write the
 * canonical JSON. Returns the output path. Separated from the printing
 * wrapper so it stays unit-testable by return value; the optional `stderr`
 * sink defaults to a no-op so a direct caller need not supply one.
 */
export async function mergeFiles(
    argv: readonly string[],
    fs: FsLike,
    stderr: Writer = () => {},
): Promise<string> {
    const opts = parseMergeArgs(argv);
    const maps: RosettaMap[] = [];
    for (const p of opts.inputPaths) {
        maps.push(await loadMap(p, fs));
    }
    const merged = mergeMaps(maps, {
        strict: opts.strict,
        onOverride: (o) => stderr(overrideNotice(o)),
    });
    // Re-validate the fold result so a merge that produced an invalid shape
    // (e.g. an overload set that overflowed MAX_METHOD_OVERLOADS) fails loudly
    // before it is written. `validateStructure` throws a `MapValidationError`
    // the router renders with its indented issue list — same as `validate`.
    const validated = validateStructure(merged);
    await writeNew(fs, opts.outputPath, renderJson(validated), { force: opts.force });
    return opts.outputPath;
}

/**
 * Execute `rosetta merge` under the shared command contract: fold the inputs
 * and return the success message. Override notices go to `io.stderr`.
 */
export async function runMerge(argv: readonly string[], io: CommandIo): Promise<string> {
    const out = await mergeFiles(argv, io.fs, io.stderr);
    return `wrote ${out}`;
}
