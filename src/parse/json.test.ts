import { describe, it, expect } from 'vitest';
import { parseJson } from './json.js';
import { JsonParseError } from '../errors.js';

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

function expectThrows(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error('expected a throw');
}
