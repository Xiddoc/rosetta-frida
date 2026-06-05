/**
 * Canonical JSON emission + the user-facing `convertToJson` entry point.
 *
 * `convertToJson` is the single function the CLI / tooling should call
 * to turn a YAML source string into the canonical strict-JSON
 * representation that lives on disk.
 *
 * Maps are pure data: only JSON and YAML are accepted. TS/JS-module
 * ingestion was removed because it executed arbitrary code (via dynamic
 * `import()`) at author/build time before any validation ran.
 *
 * Output is deterministic: the same input always produces byte-identical
 * output, because we use a stable indent (4 spaces) and rely on
 * insertion-order preservation of object keys (which JS engines
 * guarantee for string keys).
 */

import { RosettaError } from '../errors.js';
import type { RosettaMap, RosettaMapInput } from '../types/map.js';
import { yamlToMap } from './yaml.js';
import { isModuleExtension, refuseModuleInput } from './ts-module.js';

/** Input formats accepted by `convertToJson`. */
export type ConvertFormat = 'yaml' | 'auto';

/**
 * Convert `input` (YAML source text) to canonical strict JSON.
 *
 * The `format` parameter selects the converter:
 *   - `'yaml'`: `input` is YAML *source text*; parse + validate + emit.
 *   - `'auto'`: treat `input` as YAML source. (A JS/TS-module *path*
 *               passed here is refused, never imported.)
 *
 * Output is deterministic: same input → byte-identical output.
 */
export function convertToJson(input: string, format: ConvertFormat = 'auto'): Promise<string> {
    // Conversion is fully synchronous now that TS/JS-module ingestion
    // (the only async path) is gone. The signature stays `Promise`-typed
    // for API stability; thrown errors surface as a rejected promise.
    return Promise.resolve().then(() => {
        const resolved = format === 'auto' ? detectFormat(input) : format;
        let map: RosettaMap;
        if (resolved === 'yaml') {
            map = yamlToMap(input);
        } else {
            // Unreachable when called through the public type but defensive
            // for callers that bypass TS (e.g. plain-JS consumers).
            throw new RosettaError(`unsupported convert format: ${String(resolved)}`);
        }
        return renderJson(map);
    });
}

/**
 * Render a RosettaMap as canonical strict-JSON source text.
 *
 * Uses `JSON.stringify` with a 4-space indent to match the project's
 * Prettier config, and ends with a trailing newline (POSIX convention;
 * Prettier enforces it). No comment header — the artifact is plain JSON.
 *
 * Accepts EITHER the normalised {@link RosettaMap} (always-array methods,
 * produced by the validator) or the terser {@link RosettaMapInput}
 * authoring shape (scalar-or-array methods, e.g. the `rosetta init`
 * skeleton). Both are valid on-disk artifacts and serialise identically;
 * the function only stringifies, so it is shape-agnostic.
 */
export function renderJson(map: RosettaMap | RosettaMapInput): string {
    const body = JSON.stringify(map, null, 4);
    return `${body}\n`;
}

/**
 * Detect input format from a heuristic on the raw input string. The only
 * supported input format is YAML source text; a JS/TS-module *path* (no
 * newline, module extension) is REFUSED with a helpful error rather than
 * imported. Everything else is treated as YAML.
 *
 * @throws RosettaError if `input` looks like a TS/JS-module path.
 */
export function detectFormat(input: string): 'yaml' {
    if (!input.includes('\n') && isModuleExtension(input)) {
        refuseModuleInput(input);
    }
    return 'yaml';
}
