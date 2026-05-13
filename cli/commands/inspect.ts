/**
 * `rosetta inspect <bundle.js>` — print a one-liner summary of the
 * embedded map.
 *
 * For a single-map bundle:
 *   "com.example.app@1.2.3, schema_version 1, 47 classes"
 *
 * For a registry bundle:
 *   "registry: com.example.app, versions=[1.2.3, 1.2.4], 94 classes total"
 *   (or "app=mixed" if the registry spans multiple apps)
 *
 * Designed to be greppable in CI output. No JSON, no fluff.
 */

import { parseMarkerBlock } from '../../src/marker/parse.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import type { CommandIo } from './io.js';
import { errorMessage } from './io.js';

/** Parsed argument shape for the inspect command. */
export interface InspectArgs {
    bundle: string;
}

/**
 * Parse `inspect` argv. Only one positional argument; no options
 * (V1).
 */
export function parseInspectArgs(argv: readonly string[]): InspectArgs {
    let bundle: string | undefined;
    for (const a of argv) {
        if (a.startsWith('-')) {
            throw new Error(`unknown option: ${a}`);
        }
        if (bundle !== undefined) {
            throw new Error(`unexpected positional argument: ${a}`);
        }
        bundle = a;
    }
    if (bundle === undefined) {
        throw new Error('missing required argument: <bundle.js>');
    }
    return { bundle };
}

/** Format the one-line summary of a single-map payload. */
function summarizeSingle(map: RosettaMap): string {
    const classes = Object.keys(map.classes).length;
    return `${map.app}@${map.version}, schema_version ${map.schema_version}, ${classes} classes`;
}

/** Format the one-line summary of a registry payload. */
function summarizeRegistry(maps: RosettaMapRegistry): string {
    const versions = Object.keys(maps);
    const apps = new Set<string>();
    let totalClasses = 0;
    for (const v of versions) {
        const m = maps[v];
        if (!m) continue;
        apps.add(m.app);
        totalClasses += Object.keys(m.classes).length;
    }
    const appLabel = apps.size === 1 ? [...apps][0] : 'mixed';
    return `registry: ${appLabel}, versions=[${versions.join(', ')}], ${totalClasses} classes total`;
}

/**
 * Execute the inspect command. Returns process exit code (0/1).
 */
export async function runInspect(argv: readonly string[], io: CommandIo): Promise<number> {
    let args: InspectArgs;
    try {
        args = parseInspectArgs(argv);
    } catch (err) {
        io.stderr(`inspect: ${errorMessage(err)}`);
        return 1;
    }

    let bundleText: string;
    try {
        bundleText = await io.fs.readFile(args.bundle, 'utf8');
    } catch (err) {
        io.stderr(`inspect: cannot read bundle ${args.bundle}: ${errorMessage(err)}`);
        return 1;
    }

    let parsed;
    try {
        parsed = parseMarkerBlock(bundleText);
    } catch (err) {
        io.stderr(`inspect: ${errorMessage(err)}`);
        return 1;
    }

    const line =
        parsed.kind === 'single' ? summarizeSingle(parsed.map) : summarizeRegistry(parsed.maps);
    io.stdout(line);
    return 0;
}
