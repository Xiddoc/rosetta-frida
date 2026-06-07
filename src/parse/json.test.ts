import { describe, it, expect } from 'vitest';
import { parseJson, guardInput, maxNestingDepth } from './json.js';
import { JsonParseError, MapInputTooLargeError } from '../errors.js';
import { DEFAULT_CONFIG } from '../config.js';

const DEFAULT_LIMITS = DEFAULT_CONFIG.parseLimits;

describe('parseJson — strict JSON', () => {
    it('parses an object literal', () => {
        expect(parseJson('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
    });

    it('parses an array literal', () => {
        expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses primitives', () => {
        expect(parseJson('true')).toBe(true);
        expect(parseJson('null')).toBeNull();
        expect(parseJson('42')).toBe(42);
        expect(parseJson('"hi"')).toBe('hi');
    });

    it('parses a nested structure', () => {
        const src = '{"a": {"b": [1, 2, {"c": null}]}}';
        expect(parseJson(src)).toEqual({ a: { b: [1, 2, { c: null }] } });
    });
});

describe('parseJson — strings', () => {
    it('handles escaped quotes inside strings', () => {
        expect(parseJson('"he said \\"hi\\""')).toBe('he said "hi"');
    });

    it('handles backslash escapes correctly', () => {
        expect(parseJson('"line\\nbreak"')).toBe('line\nbreak');
    });

    it('preserves comment-like sequences inside strings', () => {
        expect(parseJson('{"url": "http://example.com", "s": "/* not a comment */"}')).toEqual({
            url: 'http://example.com',
            s: '/* not a comment */',
        });
    });

    it('throws JsonParseError on an unterminated string', () => {
        expect(() => parseJson('"unterminated')).toThrow(JsonParseError);
    });
});

describe('parseJson — comments are rejected (strict)', () => {
    it('rejects a leading line comment', () => {
        expect(() => parseJson('// header comment\n{"a":1}')).toThrow(JsonParseError);
    });

    it('rejects a trailing line comment', () => {
        expect(() => parseJson('{"a":1} // trailing')).toThrow(JsonParseError);
    });

    it('rejects a leading block comment', () => {
        expect(() => parseJson('/* header */{"a":1}')).toThrow(JsonParseError);
    });

    it('rejects an inline block comment between tokens', () => {
        expect(() => parseJson('{"a": /* comment */ 1}')).toThrow(JsonParseError);
    });

    it('rejects input that is only comments', () => {
        expect(() => parseJson('// just a comment\n/* and another */')).toThrow(JsonParseError);
    });
});

describe('parseJson — trailing commas are rejected (strict)', () => {
    it('rejects a trailing comma in an object', () => {
        expect(() => parseJson('{"a":1,"b":2,}')).toThrow(JsonParseError);
    });

    it('rejects a trailing comma in an array', () => {
        expect(() => parseJson('[1,2,3,]')).toThrow(JsonParseError);
    });
});

describe('parseJson — errors', () => {
    it('throws JsonParseError on empty input', () => {
        expect(() => parseJson('')).toThrow(JsonParseError);
    });

    it('throws JsonParseError on only whitespace', () => {
        expect(() => parseJson('   \n\t  ')).toThrow(JsonParseError);
    });

    it('throws JsonParseError on malformed JSON tokens', () => {
        expect(() => parseJson('{"a": notvalid}')).toThrow(JsonParseError);
    });

    it('computes line/column from a "position N" hint past a newline (Node-version-stable)', () => {
        // Real-Node `JSON.parse` error messages changed format between
        // major versions — to keep the newline branch in
        // `positionToLineCol` covered regardless of Node version, force
        // a deterministic "position N" via a monkey-patched JSON.parse.
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            // Source `'a\nbcde'` has a newline at index 1. Position 5
            // lands on the last char, past the newline — exercises both
            // the newline branch (line +=1; column = 1) AND the
            // post-newline column increments in `positionToLineCol`.
            throw new SyntaxError('Unexpected token x at position 5');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJson('a\nbcde'));
            expect(err).toBeInstanceOf(JsonParseError);
            const je = err as JsonParseError;
            expect(je.line).toBe(2);
            expect(je.column).toBe(4);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });

    it('reports approximate line/column for malformed JSON', () => {
        try {
            parseJson('{\n  "a": ?\n}');
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(JsonParseError);
            const err = e as JsonParseError;
            expect(err.line).toBeGreaterThanOrEqual(1);
            expect(err.column).toBeGreaterThanOrEqual(1);
        }
    });

    it('handles JSON.parse errors without a "position" hint gracefully', () => {
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            throw new Error('something broke (no position info)');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJson('{}'));
            expect(err).toBeInstanceOf(JsonParseError);
            const je = err as JsonParseError;
            expect(je.line).toBe(1);
            expect(je.column).toBe(1);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });

    it('clamps an out-of-range "position N" hint to the source length', () => {
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            throw new SyntaxError('Unexpected token x at position 999999');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJson('{}'));
            expect(err).toBeInstanceOf(JsonParseError);
            const je = err as JsonParseError;
            expect(je.line).toBeGreaterThanOrEqual(1);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });

    it('handles non-Error JSON.parse rejections', () => {
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'string-rejection';
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            expect(() => parseJson('{}')).toThrow(JsonParseError);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });
});

describe('parseJson — pre-parse input-hardening guard (L9)', () => {
    it('parses fine under the default limits', () => {
        expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('rejects input over the byte limit', () => {
        const tiny = { maxInputBytes: 8, maxNestingDepth: 64 };
        expect(() => parseJson('{"aaaa":1}', tiny)).toThrow(MapInputTooLargeError);
    });

    it('carries structured context on a byte-limit rejection', () => {
        const tiny = { maxInputBytes: 4, maxNestingDepth: 64 };
        try {
            parseJson('{"a":1}', tiny);
            throw new Error('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(MapInputTooLargeError);
            const err = e as MapInputTooLargeError;
            expect(err.kind).toBe('bytes');
            expect(err.limit).toBe(4);
            expect(err.observed).toBeGreaterThan(4);
        }
    });

    it('counts UTF-8 bytes, not UTF-16 code units, for the byte limit', () => {
        // A 3-byte (€) plus a 4-byte astral char (😀, a surrogate pair) is
        // 7 UTF-8 bytes inside a 2-char JSON string body — proving the count
        // is by encoded bytes. The whole doc `"€😀"` is 9 bytes (2 quotes + 7).
        const src = '"€\u{1f600}"';
        expect(() => parseJson(src, { maxInputBytes: 8, maxNestingDepth: 64 })).toThrow(
            MapInputTooLargeError,
        );
        // One more byte of headroom and it parses.
        expect(parseJson(src, { maxInputBytes: 9, maxNestingDepth: 64 })).toBe('€\u{1f600}');
    });

    it('counts a 2-byte UTF-8 char (U+0080..U+07FF) as 2 bytes', () => {
        // `ñ` (U+00F1) encodes to 2 UTF-8 bytes; `"ñ"` is 2 quotes + 2 = 4.
        const src = '"ñ"';
        expect(() => parseJson(src, { maxInputBytes: 3, maxNestingDepth: 64 })).toThrow(
            MapInputTooLargeError,
        );
        expect(parseJson(src, { maxInputBytes: 4, maxNestingDepth: 64 })).toBe('ñ');
    });

    it('counts a lone high surrogate as the 3-byte replacement', () => {
        // A high surrogate with no following low surrogate falls to the
        // 3-byte (replacement) branch. `"\uD800"` is 2 quotes + 3 = 5 bytes.
        const src = '"\uD800"';
        expect(() => parseJson(src, { maxInputBytes: 4, maxNestingDepth: 64 })).toThrow(
            MapInputTooLargeError,
        );
        expect(() => parseJson(src, { maxInputBytes: 5, maxNestingDepth: 64 })).not.toThrow(
            MapInputTooLargeError,
        );
    });

    it('counts a high surrogate at end-of-string as the 3-byte replacement', () => {
        // High surrogate as the FINAL char (i + 1 >= length) → the else
        // branch (3 bytes), distinct from the lone-surrogate-mid-string path.
        const src = '\uD800';
        expect(() => parseJson(src, { maxInputBytes: 2, maxNestingDepth: 64 })).toThrow(
            MapInputTooLargeError,
        );
    });

    it('rejects input over the nesting-depth limit', () => {
        const deep = `${'['.repeat(10)}${']'.repeat(10)}`;
        expect(() => parseJson(deep, { maxInputBytes: 1024, maxNestingDepth: 5 })).toThrow(
            MapInputTooLargeError,
        );
    });

    it('carries structured context on a depth-limit rejection', () => {
        try {
            parseJson('[[[[]]]]', { maxInputBytes: 1024, maxNestingDepth: 2 });
            throw new Error('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(MapInputTooLargeError);
            const err = e as MapInputTooLargeError;
            expect(err.kind).toBe('depth');
            expect(err.limit).toBe(2);
            expect(err.observed).toBeGreaterThan(2);
        }
    });

    it('accepts input exactly at the depth limit', () => {
        // Two nested arrays = depth 2, exactly the cap → allowed.
        expect(parseJson('[[1]]', { maxInputBytes: 1024, maxNestingDepth: 2 })).toEqual([[1]]);
    });

    it('does not count braces/brackets inside string literals toward depth', () => {
        // The string body is full of structural punctuation, but real depth
        // is 1 (the outer object). A cap of 1 must still accept it.
        const src = '{"s":"[[[{{{not real nesting}}}]]]"}';
        expect(parseJson(src, { maxInputBytes: 1024, maxNestingDepth: 1 })).toEqual({
            s: '[[[{{{not real nesting}}}]]]',
        });
    });

    it('handles escaped quotes/backslashes while scanning depth', () => {
        // An escaped quote inside the string must NOT end the string early
        // (which would expose the trailing `]` as structural). Real depth 1.
        const src = '{"s":"he said \\"[\\\\\\"\\""}';
        expect(() => parseJson(src, { maxInputBytes: 1024, maxNestingDepth: 1 })).not.toThrow();
    });
});

describe('maxNestingDepth', () => {
    it('returns 0 for a flat scalar', () => {
        expect(maxNestingDepth('42', 64)).toBe(0);
    });

    it('counts the deepest level reached', () => {
        expect(maxNestingDepth('{"a":[{"b":1}]}', 64)).toBe(3);
    });

    it('does not underflow on unbalanced closers', () => {
        // Extra `]` with depth already 0 must not push depth negative.
        expect(maxNestingDepth(']]]{}', 64)).toBe(1);
    });

    it('stops early once the cap is exceeded', () => {
        // Deeper than the cap: returns a value > cap (early-exit path).
        expect(maxNestingDepth('[[[[[]]]]]', 2)).toBeGreaterThan(2);
    });
});

describe('guardInput', () => {
    it('is a no-op for input within both limits', () => {
        expect(() => guardInput('{"a":1}', DEFAULT_LIMITS)).not.toThrow();
    });

    it('throws on the byte limit before checking depth', () => {
        expect(() => guardInput('{"a":1}', { maxInputBytes: 1, maxNestingDepth: 64 })).toThrow(
            MapInputTooLargeError,
        );
    });
});

function expectThrows(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error('expected a throw');
}
