/**
 * `loadMap` — the single front-door used by callers that want a
 * validated `RosettaMap` regardless of where the data came from.
 *
 * Inputs accepted:
 *   - An already-constructed `RosettaMap` (or any object). Passed
 *     through the validator and returned.
 *   - A strict-JSON source string. Parsed via `parseJson`, then validated.
 *   - A filesystem path string. Read via `node:fs/promises`, then
 *     parsed + validated.
 *
 * The string vs. path disambiguation rule is intentionally cheap: if
 * the first non-whitespace character looks like JSON (`{` `[` `"`
 * digit `t` `f` `n`), the string is treated as JSON source. Otherwise
 * it's treated as a path.
 *
 * Validation always runs — even on object inputs — because callers
 * should never see an internally inconsistent map.
 */

import type { RosettaMap } from '../types/map.js';
import { parseJson } from './json.js';
import { validateMap } from '../validate/schema.js';
import { DEFAULT_CONFIG, type RosettaConfig } from '../config.js';
import { readFile } from 'node:fs/promises';

/**
 * Load and validate a `RosettaMap` from any supported input form.
 *
 * String / file inputs pass through the pre-parse input-hardening guard
 * (byte-size + nesting-depth caps from `config.parseLimits`, L9) before
 * `JSON.parse`. An already-constructed object input skips parsing and so is
 * not byte/depth-guarded (it never went through the text path).
 *
 * @param input A `RosettaMap` object, a strict-JSON source string, or a path.
 * @param config Typed config; `parseLimits` bound the input-hardening guard.
 *   Defaults to {@link DEFAULT_CONFIG} (Kotlin-matched 8 MiB / depth 64).
 * @throws MapInputTooLargeError if the text exceeds a parse limit.
 * @throws JsonParseError if the string can't be parsed as JSON.
 * @throws MapValidationError if the structure doesn't satisfy the schema.
 * @throws Error (from `fs.readFile`) if a path can't be read.
 */
export async function loadMap(
    input: string | RosettaMap,
    config: RosettaConfig = DEFAULT_CONFIG,
): Promise<RosettaMap> {
    if (typeof input !== 'string') {
        return validateMap(input);
    }
    const source = looksLikeJsonSource(input) ? input : await readFile(input, 'utf8');
    const parsed = parseJson(source, config.parseLimits);
    return validateMap(parsed);
}

/**
 * Cheap heuristic: does the string's first non-whitespace character
 * look like the start of a JSON document?
 *
 * Exposed for testing.
 */
export function looksLikeJsonSource(input: string): boolean {
    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i] as string;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
        return JSON_LEADING_CHARS.has(ch);
    }
    // Pure whitespace — let parseJson surface the empty-input error.
    return true;
}

const JSON_LEADING_CHARS = new Set([
    '{',
    '[',
    '"',
    '-',
    't',
    'f',
    'n',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
]);
