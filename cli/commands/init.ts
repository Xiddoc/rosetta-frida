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

import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/types/map.js';
import type { RosettaMap } from '../../src/types/map.js';
import { renderJson } from '../../src/convert/json.js';
import {
    assertValidApp,
    assertValidVersion,
    assertContained,
    assertNoNul,
} from '../../src/parse/index.js';
import type { CommandIo, FsLike } from './io.js';
import { writeNew } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

export interface InitOptions {
    app: string;
    version: string;
    /** Output path. Defaults to `maps/<app>/<version>.json`. */
    output?: string;
    /** Overwrite an existing file at the output path. */
    force?: boolean;
}

/** Option grammar for `init`: `-o/--output <path>` and `--force/-f`. */
const INIT_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
    ],
};

/** CLI parse — returns parsed options or throws RosettaError on bad args. */
export function parseInitArgs(argv: readonly string[]): InitOptions {
    const { positionals, values, flags } = parseArgs(argv, INIT_SPEC);
    if (positionals.length !== 2) {
        throw new RosettaError(
            `init requires exactly two positional args: <app> <version> (got ${positionals.length})`,
        );
    }
    return {
        app: positionals[0] as string,
        version: positionals[1] as string,
        output: values.output,
        force: flags.force ?? false,
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
    const skeleton: RosettaMap = {
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
    // Reuse the canonical renderer (4-space indent + trailing newline) so
    // the skeleton matches the on-disk artifact byte-for-byte instead of
    // re-implementing the same JSON.stringify locally.
    return renderJson(skeleton);
}

/** Resolve the default output path: `maps/<app>/<version>.json`. */
export function defaultOutputPath(app: string, version: string): string {
    return path.join('maps', app, `${version}.json`);
}

/**
 * Core of `rosetta init`: scaffold the skeleton map and return the
 * absolute output path. Kept separate from the I/O-printing `runInit`
 * wrapper so it can be unit-tested by its return value.
 *
 * @throws RosettaError if the target already exists and `--force` was
 * not passed.
 */
export async function writeSkeleton(argv: readonly string[], fs: FsLike): Promise<string> {
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
    // writeNew is the single emit seam: it creates the parent directory,
    // then does an atomic `wx` create (the overwrite guard) unless --force,
    // closing the stat-then-write TOCTOU window.
    await writeNew(fs, outPath, renderSkeleton(opts.app, opts.version), { force: opts.force });
    return outPath;
}

/**
 * Execute `rosetta init` under the shared command contract: scaffold the
 * map and return the success message (the router prints it under the
 * uniform `rosetta init:` prefix). Handled failures throw `RosettaError`
 * for the router to format.
 */
export async function runInit(argv: readonly string[], io: CommandIo): Promise<string> {
    const out = await writeSkeleton(argv, io.fs);
    return `wrote ${out}`;
}
