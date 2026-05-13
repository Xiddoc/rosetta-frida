/**
 * JSONC (JSON with Comments) parser.
 *
 * Strategy: strip comments and trailing commas, then hand off to the
 * platform's native `JSON.parse`. Strings are scanned character-by-
 * character so that comment-like or comma-like sequences embedded
 * inside string literals survive untouched.
 *
 * Why in-tree (not `jsonc-parser`):
 *   - Zero runtime dependencies — important for a library that may
 *     end up bundled into a Frida script via `frida-compile`.
 *   - Trivial behaviour to audit and test.
 *   - We control error reporting (line/column) precisely.
 *
 * What we accept beyond strict JSON:
 *   - `// line comments` (terminated by `\n` or end-of-input).
 *   - Block comments delimited by slash-star and star-slash. They do
 *     not nest — the first close-marker ends the comment, matching
 *     JS / C / JSONC convention.
 *   - Trailing commas in object and array literals.
 *
 * Errors:
 *   - Unterminated block comments throw `JsoncParseError` with the
 *     line/column where the comment opened.
 *   - Downstream `JSON.parse` failures are re-thrown as
 *     `JsoncParseError` with best-effort position info.
 */

import { JsoncParseError } from '../errors.js';

/**
 * Parse a JSONC string into a JavaScript value.
 *
 * @throws JsoncParseError on syntactic errors (with line/column).
 */
export function parseJsonc(source: string): unknown {
    const stripped = stripCommentsAndTrailingCommas(source);
    try {
        return JSON.parse(stripped) as unknown;
    } catch (e) {
        // `JSON.parse` errors carry "at position N" in modern V8.
        // Reconstruct (line, col) from the original source whenever we can.
        const message = e instanceof Error ? e.message : String(e);
        const pos = extractJsonPosition(message);
        const { line, column } =
            pos === null ? { line: 1, column: 1 } : positionToLineCol(stripped, pos);
        throw new JsoncParseError(
            `Invalid JSON after stripping comments: ${message}`,
            line,
            column,
        );
    }
}

/**
 * Strip line comments, block comments, and trailing commas — preserving
 * the byte length of each replaced run so that downstream `JSON.parse`
 * position offsets line up with the original source.
 *
 * Exposed for testing.
 */
export function stripCommentsAndTrailingCommas(source: string): string {
    // Build into a char array so we can preserve length by overwriting
    // with whitespace (newlines preserved, everything else → space).
    const out: string[] = new Array<string>(source.length);
    const len = source.length;
    let i = 0;

    // Line/column tracking for error reporting on unterminated block comments.
    let line = 1;
    let column = 1;

    // Track positions of commas that *might* be trailing — we erase them
    // retroactively when we hit the next non-whitespace `}` or `]`.
    let lastCommaIndex = -1;

    const advanceCursor = (ch: string): void => {
        if (ch === '\n') {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    };

    while (i < len) {
        const ch = source[i] as string;

        // String literal — copy verbatim, handling backslash escapes.
        if (ch === '"') {
            out[i] = ch;
            advanceCursor(ch);
            i += 1;
            while (i < len) {
                const c = source[i] as string;
                out[i] = c;
                advanceCursor(c);
                i += 1;
                if (c === '\\') {
                    // Copy the next char as part of the escape (if present).
                    if (i < len) {
                        const esc = source[i] as string;
                        out[i] = esc;
                        advanceCursor(esc);
                        i += 1;
                    }
                    continue;
                }
                if (c === '"') break;
            }
            lastCommaIndex = -1;
            continue;
        }

        // Line comment — replace with spaces up to (but not including) newline.
        if (ch === '/' && source[i + 1] === '/') {
            while (i < len && source[i] !== '\n') {
                out[i] = ' ';
                column += 1;
                i += 1;
            }
            // Don't consume the newline itself — let the outer loop handle it
            // so line tracking stays correct.
            continue;
        }

        // Block comment — replace with spaces/newlines until `*/`.
        if (ch === '/' && source[i + 1] === '*') {
            const openLine = line;
            const openColumn = column;
            // Replace `/*` with two spaces.
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            column += 2;
            let closed = false;
            while (i < len) {
                const c = source[i] as string;
                if (c === '*' && source[i + 1] === '/') {
                    out[i] = ' ';
                    out[i + 1] = ' ';
                    i += 2;
                    column += 2;
                    closed = true;
                    break;
                }
                // Preserve newlines so line numbers stay correct.
                out[i] = c === '\n' ? '\n' : ' ';
                advanceCursor(c);
                i += 1;
            }
            if (!closed) {
                throw new JsoncParseError('Unterminated block comment', openLine, openColumn);
            }
            continue;
        }

        // Comma — remember its position for trailing-comma detection.
        if (ch === ',') {
            out[i] = ch;
            lastCommaIndex = i;
            advanceCursor(ch);
            i += 1;
            continue;
        }

        // Closing bracket — if the most recent non-whitespace token before
        // this was a comma, that comma was trailing → erase it.
        if (ch === '}' || ch === ']') {
            if (lastCommaIndex !== -1) {
                out[lastCommaIndex] = ' ';
            }
            out[i] = ch;
            lastCommaIndex = -1;
            advanceCursor(ch);
            i += 1;
            continue;
        }

        // Whitespace — keep tracking but don't reset lastCommaIndex
        // (whitespace between a comma and a closing bracket still counts
        // as trailing).
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            out[i] = ch;
            advanceCursor(ch);
            i += 1;
            continue;
        }

        // Any other significant character — copy and reset trailing-comma state.
        out[i] = ch;
        lastCommaIndex = -1;
        advanceCursor(ch);
        i += 1;
    }

    return out.join('');
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
