/**
 * `rosetta init <app> <version> [-o <path>] [--force]`
 *
 * Writes a skeleton JSONC map to disk. The skeleton has:
 *   - Header comments documenting each required field.
 *   - All required top-level metadata filled in.
 *   - An empty `classes: {}`.
 *   - A single example class entry that's commented out (kept short, so
 *     a new user reads the comment, uncomments, and edits inline).
 *
 * Refuses to overwrite an existing file unless `--force` is passed.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';

export interface InitOptions {
    app: string;
    version: string;
    /** Output path. Defaults to `maps/<app>/<version>.json`. */
    output?: string;
    /** Overwrite an existing file at the output path. */
    force?: boolean;
}

/** CLI parse — returns parsed options or throws RosettaError on bad args. */
export function parseInitArgs(argv: readonly string[]): InitOptions {
    const positional: string[] = [];
    let output: string | undefined;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-o' || arg === '--output') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new RosettaError(`${arg} requires a value`);
            }
            output = next;
            i++;
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg !== undefined && arg.startsWith('-')) {
            throw new RosettaError(`unknown flag: ${arg}`);
        } else if (arg !== undefined) {
            positional.push(arg);
        }
    }
    if (positional.length !== 2) {
        throw new RosettaError(
            `init requires exactly two positional args: <app> <version> (got ${positional.length})`,
        );
    }
    return {
        app: positional[0] as string,
        version: positional[1] as string,
        output,
        force,
    };
}

/** Generate the skeleton JSONC content for an (app, version) pair. */
export function renderSkeleton(app: string, version: string): string {
    return `// rosetta-frida map — skeleton scaffold.
//
// Edit this file to fill in real-name → obfuscated-name mappings for
// each class, method, and field you want to hook in
// ${app}@${version}.
//
// Top-level fields:
//   schema_version: integer — must be 1 (current schema).
//   app:            string  — Android package name.
//   version:        string  — app version.
//   captured_at:    string  — ISO date this map was captured.
//   sources:        array   — provenance (which tool produced which entries).
//   classes:        object  — keyed by real fully-qualified class name.
//
// See maps/com.example.app/3.4.5.json for a fully-worked example
// demonstrating every supported field.
{
    "schema_version": 1,
    "app": "${app}",
    "version": "${version}",
    "captured_at": "",
    "sources": [
        {
            "tool": "hand-authored",
            "classes": 0,
            "notes": "initial scaffold"
        }
    ],
    "classes": {
        // Example class entry (uncomment + edit to use):
        //
        // "com.example.app.IRemoteService$Stub": {
        //     "obfuscated": "aaaa",
        //     "kind": "aidl_stub",
        //     "aidl_descriptor": "com.example.app.IRemoteService",
        //     "methods": {
        //         "requestTicket": {
        //             "obfuscated": "c",
        //             "signature": "(Landroid/os/Bundle;Lbbbb;)V",
        //             "aidl_txn": 2
        //         }
        //     },
        //     "fields": {
        //         "sessionId": {
        //             "obfuscated": "a",
        //             "type": "Ljava/lang/String;"
        //         }
        //     }
        // }
    }
}
`;
}

/** Resolve the default output path: `maps/<app>/<version>.json`. */
export function defaultOutputPath(app: string, version: string): string {
    return path.join('maps', app, `${version}.json`);
}

/**
 * Execute `rosetta init`. Returns the absolute output path on success.
 *
 * @throws RosettaError if the target already exists and `--force` was
 * not passed.
 */
export async function runInit(argv: readonly string[], fsImpl: typeof fs = fs): Promise<string> {
    const opts = parseInitArgs(argv);
    const outPath = opts.output ?? defaultOutputPath(opts.app, opts.version);
    if (!opts.force && (await fileExists(outPath, fsImpl))) {
        throw new RosettaError(
            `refusing to overwrite existing file: ${outPath} (pass --force to overwrite)`,
        );
    }
    await fsImpl.mkdir(path.dirname(outPath), { recursive: true });
    await fsImpl.writeFile(outPath, renderSkeleton(opts.app, opts.version), 'utf8');
    return outPath;
}

async function fileExists(p: string, fsImpl: typeof fs): Promise<boolean> {
    try {
        await fsImpl.stat(p);
        return true;
    } catch {
        return false;
    }
}
