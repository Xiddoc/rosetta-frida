/**
 * `loadMap` — the single front-door used by callers that want a
 * validated `RosettaMap` regardless of where the data came from.
 *
 * Inputs accepted:
 *   - An already-constructed `RosettaMap` (or any object). Passed
 *     through the validator and returned.
 *   - A JSONC source string. Parsed via `parseJsonc`, then validated.
 *   - A filesystem path string. Read via `node:fs/promises`, then
 *     parsed + validated.
 *
 * The string vs. path disambiguation rule is intentionally cheap: if
 * the first non-whitespace character looks like JSON (`{` `[` `"`
 * digit `t` `f` `n` `/`), the string is treated as JSONC source.
 * Otherwise it's treated as a path. `/` is in the "source" set so
 * that a JSONC literal beginning with a block-comment banner is not
 * mistaken for an absolute path.
 *
 * Validation always runs — even on object inputs — because callers
 * should never see an internally inconsistent map.
 */

import type { RosettaMap } from '../types/map.js';
import { parseJsonc } from './jsonc.js';
import { validateMap } from '../validate/schema.js';
import { readFile } from 'node:fs/promises';

/**
 * Load and validate a `RosettaMap` from any supported input form.
 *
 * @throws JsoncParseError if the string can't be parsed as JSONC.
 * @throws MapValidationError if the structure doesn't satisfy the
 *         schema.
 * @throws Error (from `fs.readFile`) if a path can't be read.
 */
export async function loadMap(input: string | RosettaMap): Promise<RosettaMap> {
    if (typeof input !== 'string') {
        return validateMap(input);
    }
    const source = looksLikeJsoncSource(input) ? input : await readFile(input, 'utf8');
    const parsed = parseJsonc(source);
    return validateMap(parsed);
}

/**
 * Cheap heuristic: does the string's first non-whitespace character
 * look like the start of a JSONC document?
 *
 * Exposed for testing.
 */
export function looksLikeJsoncSource(input: string): boolean {
    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i] as string;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
        return JSON_LEADING_CHARS.has(ch);
    }
    // Pure whitespace — let parseJsonc surface the empty-input error.
    return true;
}

const JSON_LEADING_CHARS = new Set([
    '{',
    '[',
    '"',
    '/',
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
