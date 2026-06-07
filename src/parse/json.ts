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

import { JsonParseError, MapInputTooLargeError } from '../errors.js';
import { DEFAULT_CONFIG, type ParseLimits } from '../config.js';

/**
 * Parse a strict-JSON string into a JavaScript value.
 *
 * Before `JSON.parse` runs, two cheap denial-of-service guards (L9) reject
 * a hostile or corrupt blob fail-fast: a UTF-8 byte-size cap and a
 * structural nesting-depth cap, both sourced from `limits` (Kotlin-matched
 * defaults via the typed config). This mirrors the Kotlin `MapLoader`
 * pre-parse guard so a map that loads on one client loads on the other.
 *
 * @param source The strict-JSON source text.
 * @param limits Pre-parse input-hardening limits. Defaults to the resolved
 *   config's `parseLimits` (8 MiB / depth 64).
 * @throws MapInputTooLargeError if `source` exceeds the byte or depth limit.
 * @throws JsonParseError on any syntax error (with line/column).
 *   Comments and trailing commas are NOT accepted — they parse as errors.
 */
export function parseJson(
    source: string,
    limits: ParseLimits = DEFAULT_CONFIG.parseLimits,
): unknown {
    guardInput(source, limits);
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
 * Cheap pre-parse denial-of-service guard (L9): reject oversized input by
 * UTF-8 byte length, then scan once for excessive structural nesting (which
 * would risk a stack overflow in a recursive consumer). Mirrors the Kotlin
 * `MapLoader.guardInput`.
 *
 * @throws MapInputTooLargeError if either limit is exceeded.
 */
export function guardInput(source: string, limits: ParseLimits): void {
    const bytes = utf8ByteLength(source, limits.maxInputBytes);
    if (bytes > limits.maxInputBytes) {
        throw new MapInputTooLargeError(
            `Map input is ${bytes} bytes, over the ${limits.maxInputBytes}-byte limit`,
            'bytes',
            bytes,
            limits.maxInputBytes,
        );
    }
    const depth = maxNestingDepth(source, limits.maxNestingDepth);
    if (depth > limits.maxNestingDepth) {
        throw new MapInputTooLargeError(
            `Map input nests to depth ${depth}, over the ${limits.maxNestingDepth} limit`,
            'depth',
            depth,
            limits.maxNestingDepth,
        );
    }
}

/**
 * Count the UTF-8 byte length of `source` without allocating a Buffer (the
 * library may run inside a Frida JS host with no Node `Buffer`). Surrogate
 * pairs are handled: a high surrogate is consumed together with its low
 * surrogate as a single 4-byte code point.
 *
 * `limit` short-circuits the count: once the running total EXCEEDS `limit`
 * there is nothing more to learn (the caller only tests `bytes > limit`), so
 * we bail out early rather than walk a multi-megabyte hostile blob to the
 * end. Mirrors the Kotlin twin's `if (bytes > MAX_INPUT_BYTES) return bytes`.
 * The returned value on early-exit is a lower bound that is still strictly
 * greater than `limit`, so the comparison and the over-size rejection hold.
 */
function utf8ByteLength(source: string, limit: number): number {
    let bytes = 0;
    for (let i = 0; i < source.length; i += 1) {
        const code = source.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
            // High surrogate followed by a low surrogate → one 4-byte char.
            const next = source.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i += 1;
            } else {
                // Lone high surrogate — encodes as the 3-byte replacement.
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
        // Early-exit: the caller only needs to know we are over the limit.
        if (bytes > limit) return bytes;
    }
    return bytes;
}

/**
 * Single-pass scan of the maximum `{`/`[` nesting depth, skipping over
 * string literals so structural punctuation inside strings is ignored.
 * Returns the deepest level reached. Stops early once the cap is exceeded —
 * there is nothing deeper to learn and the work stays bounded. Mirrors the
 * Kotlin `MapLoader.maxNestingDepth`.
 */
export function maxNestingDepth(source: string, cap: number): number {
    let depth = 0;
    let max = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            depth += 1;
            if (depth > max) max = depth;
            // Once we've exceeded the cap there is nothing deeper to learn.
            if (max > cap) return max;
        } else if (ch === '}' || ch === ']') {
            if (depth > 0) depth -= 1;
        }
    }
    return max;
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
