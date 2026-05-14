#!/usr/bin/env node
/**
 * sigmatcher-cli: thin command-line wrapper around the sigmatcher
 * adapter. Reads a sigmatcher `raw`-format JSON file, runs the
 * adapter, and prints the resulting JSONC map to stdout (or `-o`).
 *
 * Intended use: invoked from `regenerate-goldens.sh` and the CI
 * pipeline workflow after `sigmatcher analyze`. Not part of the
 * library's public surface — lives in `tools/` and is excluded from
 * `npm run build`.
 *
 * Usage:
 *   sigmatcher-cli <raw.json> \
 *       --app <pkg> \
 *       --version <ver> \
 *       [--captured-at <iso-date>] \
 *       [--apk-sha256 <hex>] \
 *       [--method-name-map <file.json>] \
 *       [--class-kind-map  <file.json>] \
 *       [-o <out.jsonc>]
 *
 * Both auxiliary `--*-map` files are JSON objects. Their shape matches
 * the adapter options:
 *   method-name-map: { definitionName: realMethodName, ... }
 *   class-kind-map:  { realClassFqn: ClassKind, ... }
 *
 * Exit codes:
 *   0  — success
 *   1  — adapter or parse error
 *   2  — unexpected runtime error
 */

import { readFile, writeFile } from 'node:fs/promises';
import { sigmatcherRawToRosettaMap, type SigmatcherAdapterOptions } from './sigmatcher.js';
import type { ClassKind } from '../../src/types/map.js';
import { RosettaError } from '../../src/errors.js';

interface CliArgs {
    rawPath: string;
    app: string;
    version: string;
    capturedAt?: string;
    apkSha256?: string;
    methodNameMapPath?: string;
    classKindMapPath?: string;
    outPath?: string;
}

function usage(): string {
    return [
        'Usage: sigmatcher-cli <raw.json> \\',
        '         --app <pkg> --version <ver> \\',
        '         [--captured-at <iso>] [--apk-sha256 <hex>] \\',
        '         [--method-name-map <file.json>] \\',
        '         [--class-kind-map  <file.json>] \\',
        '         [-o <out.jsonc>]',
    ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
    const positional: string[] = [];
    const flags: Record<string, string | undefined> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] as string;
        if (a === '--app') flags.app = argv[++i];
        else if (a === '--version') flags.version = argv[++i];
        else if (a === '--captured-at') flags.capturedAt = argv[++i];
        else if (a === '--apk-sha256') flags.apkSha256 = argv[++i];
        else if (a === '--method-name-map') flags.methodNameMap = argv[++i];
        else if (a === '--class-kind-map') flags.classKindMap = argv[++i];
        else if (a === '-o' || a === '--output') flags.out = argv[++i];
        else if (a.startsWith('--')) throw new RosettaError(`unknown flag: ${a}`);
        else positional.push(a);
    }
    if (positional.length !== 1) {
        throw new RosettaError(
            `expected exactly one positional argument <raw.json>, got ${positional.length}`,
        );
    }
    if (!flags.app) throw new RosettaError('--app is required');
    if (!flags.version) throw new RosettaError('--version is required');

    const args: CliArgs = {
        rawPath: positional[0] as string,
        app: flags.app,
        version: flags.version,
    };
    if (flags.capturedAt !== undefined) args.capturedAt = flags.capturedAt;
    if (flags.apkSha256 !== undefined) args.apkSha256 = flags.apkSha256;
    if (flags.methodNameMap !== undefined) args.methodNameMapPath = flags.methodNameMap;
    if (flags.classKindMap !== undefined) args.classKindMapPath = flags.classKindMap;
    if (flags.out !== undefined) args.outPath = flags.out;
    return args;
}

async function loadJson(path: string): Promise<unknown> {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as unknown;
}

async function main(argv: readonly string[]): Promise<number> {
    let parsed: CliArgs;
    try {
        parsed = parseArgs(argv);
    } catch (e) {
        process.stderr.write(`error: ${(e as Error).message}\n\n${usage()}\n`);
        return 1;
    }

    let raw: unknown;
    let methodNameMap: Record<string, string> | undefined;
    let classKindMap: Record<string, ClassKind> | undefined;
    try {
        raw = await loadJson(parsed.rawPath);
        if (parsed.methodNameMapPath) {
            methodNameMap = (await loadJson(parsed.methodNameMapPath)) as Record<string, string>;
        }
        if (parsed.classKindMapPath) {
            classKindMap = (await loadJson(parsed.classKindMapPath)) as Record<string, ClassKind>;
        }
    } catch (e) {
        process.stderr.write(`error reading inputs: ${(e as Error).message}\n`);
        return 1;
    }

    const options: SigmatcherAdapterOptions = {
        app: parsed.app,
        version: parsed.version,
    };
    if (parsed.capturedAt !== undefined) options.capturedAt = parsed.capturedAt;
    if (parsed.apkSha256 !== undefined) options.apkSha256 = parsed.apkSha256;
    if (methodNameMap !== undefined) options.methodNameMap = methodNameMap;
    if (classKindMap !== undefined) options.classKindMap = classKindMap;

    let mapJsonc: string;
    try {
        const map = sigmatcherRawToRosettaMap(raw, options);
        mapJsonc = formatAsJsonc(map);
    } catch (e) {
        process.stderr.write(`adapter error: ${(e as Error).message}\n`);
        return 1;
    }

    if (parsed.outPath) {
        await writeFile(parsed.outPath, mapJsonc, 'utf8');
    } else {
        process.stdout.write(mapJsonc);
    }
    return 0;
}

/**
 * Format the assembled map as JSONC. We emit pure JSON content with a
 * leading comment header explaining that this file is auto-generated.
 * Pure JSON is also valid JSONC, so this stays parser-compatible.
 */
function formatAsJsonc(map: unknown): string {
    const header =
        '// rosetta-frida map — auto-generated by tools/adapters/sigmatcher-cli.ts.\n' +
        '// Do not edit by hand. Re-run regenerate-goldens.sh after intentional\n' +
        '// signature changes and review the diff before committing.\n';
    return header + JSON.stringify(map, null, 4) + '\n';
}

// Invocation guard so this file is importable in tests without running.
const invokedDirectly =
    typeof process !== 'undefined' &&
    typeof process.argv?.[1] === 'string' &&
    process.argv[1].endsWith('sigmatcher-cli.ts');

if (invokedDirectly) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err: unknown) => {
            process.stderr.write(
                `sigmatcher-cli: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(2);
        },
    );
}

export { main as runSigmatcherCli, parseArgs, formatAsJsonc };
