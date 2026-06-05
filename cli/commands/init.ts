/**
 * `rosetta init <app> <version> [-o <path>] [--force]`
 *
 * Writes a skeleton strict-JSON map to disk. The skeleton has:
 *   - All required top-level metadata filled in (with placeholder
 *     `version_code: 0` for the author to replace).
 *   - A single worked example class entry under `classes` so a new
 *     author sees the shape and edits it in place.
 *
 * The artifact is plain JSON (no comments). Field documentation lives in
 * `docs/maps/format.md`, not inline — keeping the artifact machine-clean.
 *
 * Refuses to overwrite an existing file unless `--force` is passed.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/types/map.js';
import {
    assertValidApp,
    assertValidVersion,
    assertContained,
    assertNoNul,
} from '../../src/parse/index.js';

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

/**
 * Generate the skeleton strict-JSON content for an (app, version) pair.
 *
 * The output is valid against the schema except for `version_code: 0`
 * and the example obfuscated names, which the author replaces. See
 * `docs/maps/format.md` for field documentation, and
 * `maps/com.example.app/3.4.5.json` for a fully-worked example.
 */
export function renderSkeleton(app: string, version: string): string {
    const skeleton = {
        schema_version: CURRENT_SCHEMA_VERSION,
        app,
        version,
        version_code: 0,
        captured_at: '',
        sources: [
            {
                tool: 'hand-authored',
                classes: 1,
                notes: 'initial scaffold',
            },
        ],
        classes: {
            'com.example.app.IRemoteService$Stub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
                aidl_descriptor: 'com.example.app.IRemoteService',
                methods: {
                    requestTicket: {
                        obfuscated: 'c',
                        signature: '(Landroid/os/Bundle;Lbbbb;)V',
                        aidl_txn: 2,
                    },
                },
                fields: {
                    sessionId: {
                        obfuscated: 'a',
                        type: 'Ljava/lang/String;',
                    },
                },
            },
        },
    };
    return JSON.stringify(skeleton, null, 4) + '\n';
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
    // Validate the identity tokens BEFORE they are interpolated into a path.
    assertValidApp(opts.app);
    assertValidVersion(opts.version);
    const outPath = opts.output ?? defaultOutputPath(opts.app, opts.version);
    if (opts.output !== undefined) {
        // Operator-supplied -o: reject NUL but allow any location (e.g. /tmp).
        // The security boundary is on the DERIVED default path (below), not on
        // explicit operator choices.
        assertNoNul(outPath);
    } else {
        // Derived default path (maps/<app>/<version>.json) — built from
        // validated tokens, but still contained to the project tree as the
        // final backstop against any edge-case traversal.
        assertContained(outPath);
    }
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
