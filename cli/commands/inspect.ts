/**
 * `rosetta inspect <bundle.js>` — print a one-liner summary of the
 * embedded map.
 *
 * For a single-map bundle:
 *   "com.example.app@1.2.3, schema_version 2, 47 classes"
 *
 * For a registry bundle:
 *   "registry: com.example.app, versions=[1.2.3, 1.2.4], 94 classes total"
 *   (or "app=mixed" if the registry spans multiple apps)
 *
 * Designed to be greppable in CI output. No JSON, no fluff.
 */

import { parseMarkerBlock } from '../../src/marker/parse.js';
import { validateMap } from '../../src/validate/schema.js';
import { RosettaError } from '../../src/errors.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import type { CommandIo } from './io.js';
import { errorMessage } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

/** Parsed argument shape for the inspect command. */
export interface InspectArgs {
    bundle: string;
}

/** Option grammar for `inspect`: no options, one positional (V1). */
const INSPECT_SPEC: ArgSpec = { options: [] };

/**
 * Parse `inspect` argv. Only one positional argument; no options
 * (V1).
 */
export function parseInspectArgs(argv: readonly string[]): InspectArgs {
    const { positionals } = parseArgs(argv, INSPECT_SPEC);
    if (positionals.length > 1) {
        throw new RosettaError(`unexpected positional argument: ${positionals[1]}`);
    }
    const bundle = positionals[0];
    if (bundle === undefined) {
        throw new RosettaError('missing required argument: <bundle.js>');
    }
    return { bundle };
}

/**
 * Count `classes` on a parsed-but-unvalidated map entry without
 * trusting its shape. A marker payload is `JSON.parse`d and cast — a
 * malformed-but-parseable map (e.g. missing `classes`) would otherwise
 * throw `TypeError` from `Object.keys(undefined)`. We treat a missing or
 * non-object `classes` as zero classes rather than crashing.
 */
function classCount(classes: unknown): number {
    return typeof classes === 'object' && classes !== null ? Object.keys(classes).length : 0;
}

/**
 * Format the one-line summary of a single-map payload.
 *
 * The payload arrives from `parseMarkerBlock` cast (not validated) to
 * `RosettaMap`. We run the canonical `validateMap` so a malformed
 * payload becomes a clean handled `MapValidationError` (exit 1) instead
 * of an unhandled `TypeError` escaping to the top-level handler (exit 2).
 */
function summarizeSingle(map: RosettaMap): string {
    const valid = validateMap(map);
    const classes = Object.keys(valid.classes).length;
    return `${valid.app}@${valid.version}, schema_version ${valid.schema_version}, ${classes} classes`;
}

/**
 * Format the one-line summary of a registry payload.
 *
 * Registry entries are intentionally tolerated when partly malformed
 * (e.g. a `null` slot, or one missing `classes`): a registry bundle is a
 * loose collection and `inspect` is a best-effort summary tool, so we
 * count what we can rather than rejecting the whole bundle. The root,
 * however, must be a non-null object — otherwise `Object.keys` would
 * throw — so the caller validates that before reaching here.
 */
function summarizeRegistry(maps: RosettaMapRegistry): string {
    const versions = Object.keys(maps);
    const apps = new Set<string>();
    let totalClasses = 0;
    for (const v of versions) {
        const m = maps[v] as { app?: unknown; classes?: unknown } | undefined;
        if (!m || typeof m !== 'object') continue;
        if (typeof m.app === 'string') apps.add(m.app);
        totalClasses += classCount(m.classes);
    }
    const appLabel = apps.size === 1 ? [...apps][0] : 'mixed';
    return `registry: ${appLabel}, versions=[${versions.join(', ')}], ${totalClasses} classes total`;
}

/**
 * Execute the inspect command under the shared contract: print the
 * one-line summary to stdout and return 0. Handled failures throw a
 * `RosettaError` the router formats under the `rosetta inspect:` prefix.
 */
export async function runInspect(argv: readonly string[], io: CommandIo): Promise<number> {
    const args = parseInspectArgs(argv);

    let bundleText: string;
    try {
        bundleText = await io.fs.readFile(args.bundle, 'utf8');
    } catch (err) {
        throw new RosettaError(`cannot read bundle ${args.bundle}: ${errorMessage(err)}`);
    }

    // parseMarkerBlock throws MarkerBlockError (a RosettaError) on a
    // missing/malformed block — let it propagate to the router.
    const parsed = parseMarkerBlock(bundleText);

    // Summarizing touches the untrusted payload shape: a single map is
    // validated, and a registry root must be a non-null object. Both
    // failure modes throw a RosettaError so a malformed-but-parseable
    // payload is a clean exit-1, not an unhandled TypeError → exit 2.
    let line: string;
    if (parsed.kind === 'single') {
        line = summarizeSingle(parsed.map);
    } else {
        if (typeof parsed.maps !== 'object' || parsed.maps === null) {
            throw new RosettaError('registry payload is not an object');
        }
        line = summarizeRegistry(parsed.maps);
    }
    io.stdout(line);
    return 0;
}
