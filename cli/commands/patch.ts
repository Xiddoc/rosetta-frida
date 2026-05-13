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
 * The new map is parsed as JSON (not JSONC) for V1. Once Agent A's
 * `loadMap` lands, this command should delegate to it so JSONC source
 * with comments and schema validation is also honored. The TODO below
 * marks that integration point.
 *
 * If the bundle has no existing marker block, `patchMarkerBlock` (in
 * src/marker/patch.ts) throws a `MarkerBlockError` which surfaces as
 * an exit-code-1 stderr line here.
 */

import { patchMarkerBlock } from '../../src/marker/patch.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import type { CommandIo } from './io.js';
import { errorMessage } from './io.js';

/** Parsed argument shape for the patch command. */
export interface PatchArgs {
    /** Compiled bundle to patch. */
    bundle: string;
    /** Path to the new map (JSON; JSONC support TBD via Agent A's loadMap). */
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
 * Minimal V1 map loader: parses the file as JSON and asserts the
 * top-level shape is either a `RosettaMap` (single) or a registry
 * (record-of-strings whose values are maps).
 *
 * TODO(integration with Agent A): once `loadMap` lands in
 *   src/parse/, replace this with that import. The wider validation
 *   surface (schema check, JSONC comments, helpful error positions)
 *   lives there; this fallback exists only so wave-1C ships
 *   independent of wave-1A's merge.
 */
function loadMapFromJsonFallback(jsonText: string): RosettaMap | RosettaMapRegistry {
    let value: unknown;
    try {
        value = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`map JSON is malformed: ${errorMessage(err)}`);
    }
    if (typeof value !== 'object' || value === null) {
        throw new Error('map JSON must be an object at top level');
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
                'map JSON is neither a RosettaMap (missing schema_version) ' +
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
        payload = loadMapFromJsonFallback(mapText);
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
