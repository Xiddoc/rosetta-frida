/**
 * `rosetta extract <bundle.js> -o <out.json>` — pull the embedded map
 * out of a compiled bundle into a standalone JSON file.
 *
 * Output is pretty-printed JSON (2-space indent — terser than the
 * 4-space indent we use inside the marker block, which is sized for
 * readability when grep-ing through compiled bundles).
 *
 * For registry bundles, the whole `__rosetta_maps` object is written.
 * Callers downstream can pluck a single version with standard JSON
 * tooling.
 */

import { parseMarkerBlock } from '../../src/marker/parse.js';
import { assertNoNul } from '../../src/parse/index.js';
import { RosettaError } from '../../src/errors.js';
import type { CommandIo } from './io.js';
import { errorMessage } from './io.js';

/** Parsed argument shape for the extract command. */
export interface ExtractArgs {
    /** Path to the compiled bundle (.js) containing the marker block. */
    bundle: string;
    /** Output path for the extracted JSON. */
    output: string;
}

/** Indent for the extracted JSON file (separate from the embed indent). */
const EXTRACT_JSON_INDENT = 2;

/**
 * Parse `extract` argv (everything after the subcommand). Throws on
 * structurally wrong invocations so the dispatcher can print usage.
 */
export function parseExtractArgs(argv: readonly string[]): ExtractArgs {
    let bundle: string | undefined;
    let output: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        // `argv[i]` is non-undefined because `i < argv.length`. The
        // string-indexed access on a `readonly string[]` widens to
        // `string | undefined` under `noUncheckedIndexedAccess`, so we
        // assert non-null once and reuse.
        const a = argv[i] as string;
        if (a === '-o' || a === '--output') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error(`${a} requires a path argument`);
            }
            output = next;
            i++;
        } else if (!a.startsWith('-')) {
            if (bundle !== undefined) {
                throw new Error(`unexpected positional argument: ${a}`);
            }
            bundle = a;
        } else {
            throw new Error(`unknown option: ${a}`);
        }
    }
    if (bundle === undefined) {
        throw new Error('missing required argument: <bundle.js>');
    }
    if (output === undefined) {
        throw new Error('missing required argument: -o <out.json>');
    }
    return { bundle, output };
}

/**
 * Execute the extract command under the shared contract: write the
 * extracted JSON and report it to stdout, returning 0. Handled failures
 * throw a `RosettaError` the router formats under the `rosetta extract:`
 * prefix.
 */
export async function runExtract(argv: readonly string[], io: CommandIo): Promise<number> {
    const args = parseExtractArgs(argv);
    // Reject NUL in the output path (content-derived path containment is
    // not applied here: operator-supplied -o may legitimately point outside
    // the project tree, e.g. /tmp/extracted.json).
    assertNoNul(args.output);

    let bundleText: string;
    try {
        bundleText = await io.fs.readFile(args.bundle, 'utf8');
    } catch (err) {
        throw new RosettaError(`cannot read bundle ${args.bundle}: ${errorMessage(err)}`);
    }

    // parseMarkerBlock throws MarkerBlockError (a RosettaError) — propagate.
    const parsed = parseMarkerBlock(bundleText);

    const payload = parsed.kind === 'single' ? parsed.map : parsed.maps;
    const text = JSON.stringify(payload, null, EXTRACT_JSON_INDENT) + '\n';

    try {
        await io.fs.writeFile(args.output, text, 'utf8');
    } catch (err) {
        throw new RosettaError(`cannot write output ${args.output}: ${errorMessage(err)}`);
    }

    io.stdout(`extract: wrote ${args.output} (${parsed.kind})`);
    return 0;
}
