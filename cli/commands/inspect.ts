/**
 * `rosetta inspect <bundle.js>` — print a one-liner summary of the
 * embedded map.
 *
 * For a single-map bundle:
 *   "com.example.app@1.2.3, schema_version 2, 47 classes"
 *
 * For a registry bundle:
 *   "registry: com.example.app, versions=[1.2.3, 1.2.4], 94 classes total"
 *   (or "mixed" if the registry spans multiple apps, "(unknown)" if no
 *   entry carries a usable app name)
 *
 * Designed to be greppable in CI output. No JSON, no fluff.
 */

import { parseMarkerBlock } from '../../src/marker/parse.js';
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
 * `inspect` is deliberately best-effort and applies ONE strictness across
 * both shapes: it reads what it can off the cast-not-validated payload and
 * never runs the heavy Zod `validateMap` on a read-only summary. That
 * removes the old single-vs-registry asymmetry (single used to be strict,
 * registry tolerant) and keeps inspect honestly looser than `patch`'s
 * emit guard and `validate`'s strict gate. The exit-1-not-exit-2 goal
 * (don't let `Object.keys(undefined)` throw on a missing `classes`) is met
 * by {@link classCount} alone; absent metadata renders as `undefined`.
 *
 * The root must be a non-null object — the caller guards that before here.
 */
function summarizeSingle(map: RosettaMap): string {
    // The payload is cast (not validated) to RosettaMap; the declared
    // field types (string / number) keep the template-literal lint happy.
    // At runtime a malformed payload may leave them `undefined`, which
    // renders as the literal "undefined" — acceptable for a best-effort
    // summary. Only `classes` gets the defensive count to avoid a throw.
    const classes = classCount((map as { classes?: unknown }).classes);
    return `${map.app}@${map.version}, schema_version ${map.schema_version}, ${classes} classes`;
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
    // `mixed` only makes sense when *several* apps were seen; an empty set
    // (every entry null/non-object or missing a string `app`) is "(unknown)",
    // not "mixed" (which would falsely imply more than one app).
    const appLabel =
        apps.size === 0 ? '(unknown)' : apps.size === 1 ? ([...apps][0] as string) : 'mixed';
    return `registry: ${appLabel}, versions=[${versions.join(', ')}], ${totalClasses} classes total`;
}

/**
 * Execute the inspect command under the shared contract: return the
 * one-line summary (the router prints it under the uniform
 * `rosetta inspect:` prefix). Handled failures throw a `RosettaError` the
 * router formats under the same prefix.
 */
export async function runInspect(argv: readonly string[], io: CommandIo): Promise<string> {
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

    // Summarizing touches the untrusted (cast-not-validated) payload, so
    // the root of either shape must be a non-null object — otherwise the
    // tolerant field reads / `Object.keys` would throw. A bad root is a
    // clean exit-1 RosettaError, not an unhandled TypeError → exit 2.
    if (parsed.kind === 'single') {
        if (typeof parsed.map !== 'object' || parsed.map === null) {
            throw new RosettaError('map payload is not an object');
        }
        return summarizeSingle(parsed.map);
    }
    if (typeof parsed.maps !== 'object' || parsed.maps === null) {
        throw new RosettaError('registry payload is not an object');
    }
    return summarizeRegistry(parsed.maps);
}
