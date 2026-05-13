/**
 * `rosetta validate <map.{json,jsonc,yaml,yml,ts,js,mjs,cjs}>`
 *
 * Loads a map via the appropriate path (auto-detected by extension),
 * runs structural validation, and prints either "OK" or a structured
 * error report. Exit code is 0 on success, 1 on failure.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RosettaError, MapValidationError } from '../../src/errors.js';
import { yamlToMap, tsModuleToMap, validateStructure } from '../../src/convert/index.js';
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
 * Strip JSONC comments (line + block) from a JSON-with-comments string.
 *
 * This is a small in-tree stripper rather than a dep — see design doc
 * Q2. It handles:
 *   - C-style line comments (slash-slash) to end-of-line.
 *   - C-style block comments (slash-star ... star-slash).
 *   - String literals — comment-style sequences inside a "..." pair
 *     are left intact, with backslash escapes respected.
 *
 * INTEGRATION NOTE: Agent A's parse layer will produce a richer JSONC
 * parser. Once that lands, this function should defer to it.
 */
export function stripJsoncComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const ch = src[i];
        const next = src[i + 1];
        // String literal — copy through, respecting backslash escapes.
        if (ch === '"') {
            out += ch;
            i++;
            while (i < n) {
                const c = src[i];
                out += c;
                i++;
                if (c === '\\' && i < n) {
                    out += src[i];
                    i++;
                    continue;
                }
                if (c === '"') break;
            }
            continue;
        }
        // Line comment.
        if (ch === '/' && next === '/') {
            i += 2;
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        // Block comment.
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            if (i < n) i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * Load a map from the filesystem, auto-detecting format from the path's
 * extension.
 */
export async function loadMap(inputPath: string, fsImpl: typeof fs = fs): Promise<RosettaMap> {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json' || ext === '.jsonc') {
        const raw = await fsImpl.readFile(inputPath, 'utf8');
        const stripped = stripJsoncComments(raw);
        let parsed: unknown;
        try {
            parsed = JSON.parse(stripped) as unknown;
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
        return tsModuleToMap(inputPath);
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
