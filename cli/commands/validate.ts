/**
 * `rosetta validate <map.{json,yaml,yml}>`
 *
 * Loads a map via the appropriate path (auto-detected by extension),
 * runs structural validation, and prints either "OK" or a structured
 * error report. Exit code is 0 on success, 1 on failure.
 *
 * Only JSON and YAML are accepted — maps are pure data. TS/JS-module
 * inputs are refused (importing a module to validate it was a
 * build-time RCE), never imported.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RosettaError, MapValidationError } from '../../src/errors.js';
import { yamlToMap, refuseModuleInput, validateStructure } from '../../src/convert/index.js';
import { parseJson } from '../../src/parse/json.js';
import { assertNoNul } from '../../src/parse/index.js';
import type { RosettaMap } from '../../src/types/map.js';

export interface ValidateOptions {
    inputPath: string;
}

/** Parse argv → ValidateOptions. */
export function parseValidateArgs(argv: readonly string[]): ValidateOptions {
    const positional: string[] = [];
    for (const arg of argv) {
        if (arg.startsWith('-')) {
            throw new RosettaError(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
    if (positional.length !== 1) {
        throw new RosettaError(
            `validate requires exactly one positional arg: <map> (got ${positional.length})`,
        );
    }
    return { inputPath: positional[0] as string };
}

/**
 * Load a map from the filesystem, auto-detecting format from the path's
 * extension.
 */
export async function loadMap(inputPath: string, fsImpl: typeof fs = fs): Promise<RosettaMap> {
    assertNoNul(inputPath);
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json') {
        const raw = await fsImpl.readFile(inputPath, 'utf8');
        let parsed: unknown;
        try {
            parsed = parseJson(raw);
        } catch (e) {
            throw new RosettaError(`JSON parse error in ${inputPath}: ${(e as Error).message}`);
        }
        return validateStructure(parsed);
    }
    if (ext === '.yaml' || ext === '.yml') {
        const raw = await fsImpl.readFile(inputPath, 'utf8');
        return yamlToMap(raw);
    }
    if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        // Maps are pure data — never import a contributor-supplied module.
        refuseModuleInput(inputPath);
    }
    throw new RosettaError(`unsupported map extension: ${ext} (path: ${inputPath})`);
}

export interface ValidateResult {
    ok: boolean;
    /** When `ok`, the validated map. */
    map?: RosettaMap;
    /** Lines that should be printed to stderr / stdout. */
    output: string[];
}

/**
 * Run `rosetta validate`. Returns a result with the textual output to
 * print and an `ok` flag the caller turns into an exit code.
 */
export async function runValidate(
    argv: readonly string[],
    fsImpl: typeof fs = fs,
): Promise<ValidateResult> {
    const opts = parseValidateArgs(argv);
    let map: RosettaMap;
    try {
        map = await loadMap(opts.inputPath, fsImpl);
    } catch (e) {
        return { ok: false, output: formatError(opts.inputPath, e) };
    }
    return {
        ok: true,
        map,
        output: [
            `OK: ${opts.inputPath} — ${map.app}@${map.version}, ` +
                `${Object.keys(map.classes).length} class(es), schema_version=${map.schema_version}`,
        ],
    };
}

function formatError(inputPath: string, e: unknown): string[] {
    const lines: string[] = [];
    if (e instanceof MapValidationError) {
        lines.push(`FAIL: ${inputPath} — ${e.message}`);
        for (const issue of e.issues) {
            const where = issue.path ? `  at ${issue.path}: ` : '  ';
            lines.push(`${where}${issue.message}`);
        }
        return lines;
    }
    if (e instanceof RosettaError) {
        lines.push(`FAIL: ${inputPath} — ${e.message}`);
        return lines;
    }
    lines.push(`FAIL: ${inputPath} — ${(e as Error).message}`);
    return lines;
}
