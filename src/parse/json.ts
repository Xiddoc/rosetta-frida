/**
 * Strict JSON parser.
 *
 * The canonical on-disk map artifact is plain, strict JSON — no
 * comments, no trailing commas. Comment-bearing formats (YAML, TS
 * modules) are *authoring inputs* handled by `src/convert/`; by the time
 * a map is loaded as an artifact it is strict JSON.
 *
 * Strategy: hand straight off to the platform's native `JSON.parse` and
 * re-throw any failure as a `JsonParseError` with best-effort
 * (line, column) reconstructed from V8's "position N" hint. Comments and
 * trailing commas therefore surface as ordinary syntax errors, which is
 * the intended behaviour — a map with comments is malformed.
 *
 * Why in-tree (not a dependency): zero runtime deps matters for a
 * library that may be bundled into a Frida script via `frida-compile`,
 * and we control error reporting (line/column) precisely.
 */

import { JsonParseError } from '../errors.js';

/**
 * Parse a strict-JSON string into a JavaScript value.
 *
 * @throws JsonParseError on any syntax error (with line/column).
 *   Comments and trailing commas are NOT accepted — they parse as errors.
 */
export function parseJson(source: string): unknown {
    try {
        return JSON.parse(source) as unknown;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const pos = extractJsonPosition(message);
        const { line, column } =
            pos === null ? { line: 1, column: 1 } : positionToLineCol(source, pos);
        throw new JsonParseError(`Invalid JSON: ${message}`, line, column);
    }
}

/**
 * Parse a "position N" hint out of a `JSON.parse` error message.
 * Returns null if the message has no recognizable position marker.
 */
function extractJsonPosition(message: string): number | null {
    const m = /position (\d+)/i.exec(message);
    if (!m) return null;
    // m[1] is the digits group; guaranteed defined by the regex shape.
    return Number.parseInt(m[1] as string, 10);
}

/** Convert a byte offset within `source` into a 1-indexed (line, column). */
function positionToLineCol(source: string, offset: number): { line: number; column: number } {
    let line = 1;
    let column = 1;
    const stop = Math.min(offset, source.length);
    for (let i = 0; i < stop; i += 1) {
        if (source[i] === '\n') {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    return { line, column };
}
