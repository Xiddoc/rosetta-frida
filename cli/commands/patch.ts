/**
 * `rosetta patch <bundle.js> --map <new.json>` — replace the embedded
 * map in a compiled bundle with a freshly emitted block sourced from
 * `<new.json>`.
 *
 * Optional `-o <out.js>` redirects the output to a new path. The
 * default is in-place: the bundle is read, patched, and written back
 * to its original path. (For CI / scripting users who want
 * "compile once, swap maps per environment" workflows.)
 *
 * The new map is parsed via `parseJson` (strict JSON). Top-level shape
 * is detected heuristically: presence of a numeric `schema_version`
 * means a single `RosettaMap`; otherwise the value is treated as a
 * `RosettaMapRegistry` keyed by version.
 *
 * If the bundle has no existing marker block, `patchMarkerBlock` (in
 * src/marker/patch.ts) throws a `MarkerBlockError` which surfaces as
 * an exit-code-1 stderr line here.
 */

import { parseJson } from '../../src/parse/json.js';
import { patchMarkerBlock } from '../../src/marker/patch.js';
import { assertContained } from '../../src/parse/index.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import type { CommandIo } from './io.js';
import { errorMessage } from './io.js';

/** Parsed argument shape for the patch command. */
export interface PatchArgs {
    /** Compiled bundle to patch. */
    bundle: string;
    /** Path to the new map (strict JSON). */
    map: string;
    /** Output path; defaults to the input bundle (in-place patch). */
    output: string;
}

/**
 * Parse `patch` argv. Required: <bundle> --map <path>. Optional:
 * -o <path> (default = in-place).
 */
export function parsePatchArgs(argv: readonly string[]): PatchArgs {
    let bundle: string | undefined;
    let mapPath: string | undefined;
    let output: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        // `argv[i]` is non-undefined inside the loop bounds; assert
        // once to satisfy `noUncheckedIndexedAccess`.
        const a = argv[i] as string;
        if (a === '--map') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error(`--map requires a path argument`);
            }
            mapPath = next;
            i++;
        } else if (a === '-o' || a === '--output') {
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
    if (mapPath === undefined) {
        throw new Error('missing required argument: --map <map.json>');
    }
    return { bundle, map: mapPath, output: output ?? bundle };
}

/**
 * Parse a map file as strict JSON and assert the top-level shape is
 * either a `RosettaMap` (single) or a registry (record-of-strings whose
 * values are maps).
 *
 * The full schema validator from `src/validate/` is intentionally NOT
 * called here — `rosetta patch` just rewrites a map slot in a bundle,
 * so a strict schema check is the user's responsibility upstream (e.g.
 * via `rosetta validate <map>` before patching). This loader only
 * enforces enough structure to pick the correct downstream emitter
 * (single-map vs registry).
 */
function loadMapForPatch(jsonText: string): RosettaMap | RosettaMapRegistry {
    let value: unknown;
    try {
        value = parseJson(jsonText);
    } catch (err) {
        throw new Error(`map is malformed: ${errorMessage(err)}`);
    }
    if (typeof value !== 'object' || value === null) {
        throw new Error('map must be an object at top level');
    }
    const obj = value as Record<string, unknown>;
    // Single-map heuristic: presence of a numeric `schema_version` at
    // the root. Otherwise, treat as registry — and at least confirm the
    // values *look* like RosettaMap objects (have `schema_version`).
    if (typeof obj.schema_version === 'number') {
        return obj as unknown as RosettaMap;
    }
    for (const v of Object.values(obj)) {
        if (
            typeof v !== 'object' ||
            v === null ||
            typeof (v as { schema_version?: unknown }).schema_version !== 'number'
        ) {
            throw new Error(
                'map is neither a RosettaMap (missing schema_version) ' +
                    'nor a registry (some value lacks schema_version)',
            );
        }
    }
    return obj as unknown as RosettaMapRegistry;
}

/**
 * Execute the patch command. Returns process exit code (0/1).
 */
export async function runPatch(argv: readonly string[], io: CommandIo): Promise<number> {
    let args: PatchArgs;
    try {
        args = parsePatchArgs(argv);
        // Contain the output path to the project tree before any IO.
        assertContained(args.output);
    } catch (err) {
        io.stderr(`patch: ${errorMessage(err)}`);
        return 1;
    }

    let bundleText: string;
    try {
        bundleText = await io.fs.readFile(args.bundle, 'utf8');
    } catch (err) {
        io.stderr(`patch: cannot read bundle ${args.bundle}: ${errorMessage(err)}`);
        return 1;
    }

    let mapText: string;
    try {
        mapText = await io.fs.readFile(args.map, 'utf8');
    } catch (err) {
        io.stderr(`patch: cannot read map ${args.map}: ${errorMessage(err)}`);
        return 1;
    }

    let payload: RosettaMap | RosettaMapRegistry;
    try {
        payload = loadMapForPatch(mapText);
    } catch (err) {
        io.stderr(`patch: ${errorMessage(err)}`);
        return 1;
    }

    let patched: string;
    try {
        patched = patchMarkerBlock(bundleText, payload);
    } catch (err) {
        io.stderr(`patch: ${errorMessage(err)}`);
        return 1;
    }

    try {
        await io.fs.writeFile(args.output, patched, 'utf8');
    } catch (err) {
        io.stderr(`patch: cannot write output ${args.output}: ${errorMessage(err)}`);
        return 1;
    }

    const inPlace = args.output === args.bundle;
    io.stdout(`patch: wrote ${args.output}${inPlace ? ' (in place)' : ''}`);
    return 0;
}
