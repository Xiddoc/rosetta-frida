/**
 * Canonical JSONC emission + the user-facing `convertToJsonc` entry point.
 *
 * `convertToJsonc` is the single function the CLI / tooling should call
 * to turn a YAML source string or TS-module path into the canonical JSONC
 * representation that lives on disk.
 *
 * Output is deterministic: the same input always produces byte-identical
 * output, because we use a stable comment header, a stable indent (4
 * spaces), and rely on insertion-order preservation of object keys (which
 * JS engines guarantee for string keys).
 */

import { extname } from 'node:path';
import { RosettaError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { yamlToMap } from './yaml.js';
import { tsModuleToMap } from './ts-module.js';

/** Input formats accepted by `convertToJsonc`. */
export type ConvertFormat = 'yaml' | 'ts' | 'auto';

/**
 * The header comments emitted at the top of every canonical JSONC map.
 *
 * Comments are wrapped in `//` so a downstream JSONC parser strips them
 * uniformly, and so users can read the header in a text editor without
 * needing block-comment awareness.
 */
const CANONICAL_HEADER = [
    '// rosetta-frida map — auto-generated canonical JSONC.',
    '//',
    '// schema_version: 1',
    '//',
    '// This file is JSON-with-comments. Any JSONC-aware tool (incl. all',
    '// modern JS bundlers and `JSON.parse` after comment-stripping) can',
    '// read it. Edit the source map, then re-run `rosetta convert` rather',
    '// than hand-editing the generated file.',
];

/**
 * Convert `input` (file path or raw source) to canonical JSONC.
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
export async function convertToJsonc(
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
    return renderJsonc(map);
}

/**
 * Render a RosettaMap as canonical JSONC source text.
 *
 * Uses `JSON.stringify` with a 4-space indent to match the project's
 * Prettier config, prepends the canonical header comments, and ends with
 * a trailing newline (POSIX convention; Prettier enforces it).
 */
export function renderJsonc(map: RosettaMap): string {
    const body = JSON.stringify(map, null, 4);
    return `${CANONICAL_HEADER.join('\n')}\n${body}\n`;
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
