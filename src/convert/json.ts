/**
 * Canonical JSON emission + the user-facing `convertToJson` entry point.
 *
 * `convertToJson` is the single function the CLI / tooling should call
 * to turn a YAML source string or TS-module path into the canonical
 * strict-JSON representation that lives on disk.
 *
 * Output is deterministic: the same input always produces byte-identical
 * output, because we use a stable indent (4 spaces) and rely on
 * insertion-order preservation of object keys (which JS engines
 * guarantee for string keys).
 */

import { extname } from 'node:path';
import { RosettaError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { yamlToMap } from './yaml.js';
import { tsModuleToMap } from './ts-module.js';

/** Input formats accepted by `convertToJson`. */
export type ConvertFormat = 'yaml' | 'ts' | 'auto';

/**
 * Convert `input` (file path or raw source) to canonical strict JSON.
 *
 * The `format` parameter selects the converter:
 *   - `'yaml'`: `input` is YAML *source text*; parse + validate + emit.
 *   - `'ts'`:   `input` is a *file path* to a TS/JS module; dynamic-import
 *               + validate + emit.
 *   - `'auto'`: heuristic. Inputs that contain a newline or are not a path
 *               with a recognized JS/TS extension are treated as YAML
 *               source. Recognized extensions: `.ts`, `.js`, `.mjs`,
 *               `.cjs`.
 *
 * Output is deterministic: same input → byte-identical output.
 */
export async function convertToJson(
    input: string,
    format: ConvertFormat = 'auto',
): Promise<string> {
    const resolved = format === 'auto' ? detectFormat(input) : format;
    let map: RosettaMap;
    if (resolved === 'yaml') {
        map = yamlToMap(input);
    } else if (resolved === 'ts') {
        map = await tsModuleToMap(input);
    } else {
        // Unreachable when called through the public type but defensive
        // for callers that bypass TS (e.g. plain-JS consumers).
        throw new RosettaError(`unsupported convert format: ${String(resolved)}`);
    }
    return renderJson(map);
}

/**
 * Render a RosettaMap as canonical strict-JSON source text.
 *
 * Uses `JSON.stringify` with a 4-space indent to match the project's
 * Prettier config, and ends with a trailing newline (POSIX convention;
 * Prettier enforces it). No comment header — the artifact is plain JSON.
 */
export function renderJson(map: RosettaMap): string {
    const body = JSON.stringify(map, null, 4);
    return `${body}\n`;
}

/**
 * Detect input format from a heuristic on the raw input string. Inputs
 * with a JS/TS extension and no newline are treated as TS module paths;
 * anything else is YAML source.
 */
export function detectFormat(input: string): 'yaml' | 'ts' {
    if (input.includes('\n')) {
        return 'yaml';
    }
    const ext = extname(input).toLowerCase();
    if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        return 'ts';
    }
    return 'yaml';
}
