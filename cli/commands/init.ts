/**
 * `rosetta init <app> <version> --version-code <code> [-o <path>] [--force]`
 *
 * Writes a skeleton strict-JSON map to disk. The skeleton has:
 *   - All required top-level metadata filled in, including the mandatory
 *     non-zero `version_code` supplied via `--version-code`.
 *   - A single worked example class entry under `classes` so a new
 *     author sees the shape and edits it in place.
 *
 * The artifact is plain JSON (no comments). Field documentation lives in
 * `docs/maps/format.md`, not inline — keeping the artifact machine-clean.
 *
 * The default output path is `maps/<app>/<version_code>.json` — obeying
 * the canonical invariant (filename == version_code) enforced by
 * rosetta-maps CI. An explicit `-o` overrides it.
 *
 * Refuses to overwrite an existing file unless `--force` is passed.
 */

import { RosettaError } from '../../src/errors.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/types/map.js';
import type { RosettaMapInput } from '../../src/types/map.js';
import { renderJson } from '../../src/convert/json.js';
import {
    assertValidApp,
    assertValidVersion,
    assertContained,
    assertNoNul,
    defaultMapPath,
} from '../../src/parse/index.js';
import type { CommandIo, FsLike } from './io.js';
import { writeNew } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

export interface InitOptions {
    app: string;
    version: string;
    /**
     * Android versionCode — the authoritative map-selection key. Required
     * and must be a positive integer. The default output filename is
     * `<version_code>.json` to obey the filename == version_code invariant.
     */
    version_code: number;
    /** Output path. Defaults to `maps/<app>/<version_code>.json`. */
    output?: string;
    /** Overwrite an existing file at the output path. */
    force?: boolean;
}

/** Option grammar for `init`: `--version-code <n>`, `-o/--output <path>`, `--force/-f`. */
const INIT_SPEC: ArgSpec = {
    options: [
        { name: 'version_code', aliases: ['--version-code'], takesValue: true },
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
    const vcRaw = values.version_code;
    if (vcRaw === undefined || vcRaw === '') {
        throw new RosettaError(
            `init requires --version-code <n> (a positive integer Android versionCode); ` +
                `without it the output filename cannot obey the filename == version_code invariant`,
        );
    }
    const version_code = Number(vcRaw);
    if (!Number.isInteger(version_code) || version_code <= 0) {
        throw new RosettaError(`--version-code must be a positive integer (got '${vcRaw}')`);
    }
    return {
        app: positionals[0] as string,
        version: positionals[1] as string,
        version_code,
        output: values.output,
        force: flags.force ?? false,
    };
}

/**
 * Generate the skeleton strict-JSON content for an (app, version, version_code)
 * triple.
 *
 * The output is valid against the schema; the example obfuscated names are
 * placeholders the author replaces. See `docs/maps/format.md` for field
 * documentation, and `maps/com.example.app/30405.json` for a fully-worked
 * example.
 */
export function renderSkeleton(app: string, version: string, version_code: number): string {
    const skeleton: RosettaMapInput = {
        schema_version: CURRENT_SCHEMA_VERSION,
        app,
        version,
        version_code,
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
                kind: 'class',
                methods: {
                    requestTicket: {
                        obfuscated: 'c',
                        signature: '(Landroid/os/Bundle;Lbbbb;)V',
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

/**
 * Resolve the default output path: `maps/<app>/<version_code>.json`.
 *
 * Thin alias over the shared {@link defaultMapPath} helper so `init` and
 * `pull` derive the canonical filename (`basename == version_code`) from
 * one place. Re-exported under the historical name for callers/tests.
 */
export const defaultOutputPath = defaultMapPath;

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
    const outPath = opts.output ?? defaultOutputPath(opts.app, opts.version_code);
    if (opts.output !== undefined) {
        // Operator-supplied -o: reject NUL but allow any location (e.g. /tmp).
        // The security boundary is on the DERIVED default path (below), not on
        // explicit operator choices.
        assertNoNul(outPath);
    } else {
        // Derived default path (maps/<app>/<version_code>.json) — built from
        // validated tokens, but still contained to the project tree as the
        // final backstop against any edge-case traversal.
        assertContained(outPath);
    }
    // writeNew is the single emit seam: it creates the parent directory,
    // then does an atomic `wx` create (the overwrite guard) unless --force,
    // closing the stat-then-write TOCTOU window.
    await writeNew(fs, outPath, renderSkeleton(opts.app, opts.version, opts.version_code), {
        force: opts.force,
    });
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
