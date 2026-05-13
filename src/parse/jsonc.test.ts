import { describe, it, expect } from 'vitest';
import { parseJsonc, stripCommentsAndTrailingCommas } from './jsonc.js';
import { JsoncParseError } from '../errors.js';

describe('parseJsonc — plain JSON', () => {
    it('parses an object literal', () => {
        expect(parseJsonc('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
    });

    it('parses an array literal', () => {
        expect(parseJsonc('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses primitives', () => {
        expect(parseJsonc('true')).toBe(true);
        expect(parseJsonc('null')).toBeNull();
        expect(parseJsonc('42')).toBe(42);
        expect(parseJsonc('"hi"')).toBe('hi');
    });

    it('parses a nested structure', () => {
        const src = '{"a": {"b": [1, 2, {"c": null}]}}';
        expect(parseJsonc(src)).toEqual({ a: { b: [1, 2, { c: null }] } });
    });
});

describe('parseJsonc — line comments', () => {
    it('strips a leading line comment', () => {
        expect(parseJsonc('// header comment\n{"a":1}')).toEqual({ a: 1 });
    });

    it('strips a trailing line comment (no newline at EOF)', () => {
        expect(parseJsonc('{"a":1} // trailing')).toEqual({ a: 1 });
    });

    it('strips multiple line comments interspersed with structure', () => {
        const src = `// top
{
  "a": 1, // after value
  "b": 2  // another
}
// EOF comment`;
        expect(parseJsonc(src)).toEqual({ a: 1, b: 2 });
    });

    it('preserves line comments inside strings', () => {
        expect(parseJsonc('{"url": "http://example.com"}')).toEqual({
            url: 'http://example.com',
        });
    });

    it('treats `//` at the very end of input as a comment to EOF', () => {
        expect(parseJsonc('42 //')).toBe(42);
    });
});

describe('parseJsonc — block comments', () => {
    it('strips a leading block comment', () => {
        expect(parseJsonc('/* header */{"a":1}')).toEqual({ a: 1 });
    });

    it('strips a multi-line block comment', () => {
        const src = `/*
 * Big banner
 * across multiple lines
 */
{"a":1}`;
        expect(parseJsonc(src)).toEqual({ a: 1 });
    });

    it('strips a block comment between tokens', () => {
        expect(parseJsonc('{"a": /* comment */ 1}')).toEqual({ a: 1 });
    });

    it('preserves block-comment-like sequences inside strings', () => {
        expect(parseJsonc('{"s": "/* not a comment */"}')).toEqual({
            s: '/* not a comment */',
        });
    });

    it('a block comment containing // is fine', () => {
        expect(parseJsonc('/* has // inside */{"a":1}')).toEqual({ a: 1 });
    });

    it('a block comment containing another /* (non-nesting) closes at the first */', () => {
        // Standard JSONC/JS semantics: block comments don't nest. The
        // inner `/*` is just text; the outer comment closes at the
        // first `*/`. The "*/ }" sequence that follows is real JSON.
        expect(parseJsonc('/* outer /* inner */ {"a":1}')).toEqual({ a: 1 });
    });

    it('throws JsoncParseError with the OPEN position on unterminated block comment', () => {
        const src = '\n  /* never closed';
        try {
            parseJsonc(src);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(JsoncParseError);
            const err = e as JsoncParseError;
            expect(err.line).toBe(2);
            expect(err.column).toBe(3);
            expect(err.message).toMatch(/Unterminated/);
        }
    });
});

describe('parseJsonc — strings', () => {
    it('handles escaped quotes inside strings', () => {
        expect(parseJsonc('"he said \\"hi\\""')).toBe('he said "hi"');
    });

    it('handles backslash escapes correctly', () => {
        expect(parseJsonc('"line\\nbreak"')).toBe('line\nbreak');
    });

    it('handles a backslash at the very end of a string', () => {
        expect(parseJsonc('"a\\\\b"')).toBe('a\\b');
    });

    it('a string can contain commas without breaking trailing-comma logic', () => {
        expect(parseJsonc('{"x": "a,b,c,"}')).toEqual({ x: 'a,b,c,' });
    });

    it('a string immediately before a closing bracket does not eat a real comma', () => {
        expect(parseJsonc('[1, 2, "trailing"]')).toEqual([1, 2, 'trailing']);
    });

    it('handles an unterminated string by surfacing a JsoncParseError from JSON.parse', () => {
        expect(() => parseJsonc('"unterminated')).toThrow(JsoncParseError);
    });
});

describe('parseJsonc — trailing commas', () => {
    it('accepts a trailing comma in an object', () => {
        expect(parseJsonc('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
    });

    it('accepts a trailing comma in an array', () => {
        expect(parseJsonc('[1,2,3,]')).toEqual([1, 2, 3]);
    });

    it('accepts a trailing comma followed by whitespace before the closer', () => {
        expect(parseJsonc('[1, 2, 3,\n  ]')).toEqual([1, 2, 3]);
    });

    it('accepts a trailing comma followed by a comment before the closer', () => {
        expect(parseJsonc('[1, 2, 3, /* last */]')).toEqual([1, 2, 3]);
    });

    it('does NOT remove non-trailing commas', () => {
        expect(parseJsonc('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('accepts nested trailing commas', () => {
        expect(parseJsonc('{"a":[1,2,],"b":{"c":3,},}')).toEqual({
            a: [1, 2],
            b: { c: 3 },
        });
    });
});

describe('parseJsonc — errors', () => {
    it('throws JsoncParseError on empty input', () => {
        expect(() => parseJsonc('')).toThrow(JsoncParseError);
    });

    it('throws JsoncParseError on only whitespace', () => {
        expect(() => parseJsonc('   \n\t  ')).toThrow(JsoncParseError);
    });

    it('throws JsoncParseError on only comments', () => {
        expect(() => parseJsonc('// just a comment\n/* and another */')).toThrow(JsoncParseError);
    });

    it('throws JsoncParseError on malformed JSON tokens', () => {
        expect(() => parseJsonc('{"a": notvalid}')).toThrow(JsoncParseError);
    });

    it('computes line/column from a "position N" hint past a newline (Node-version-stable)', () => {
        // Real-Node `JSON.parse` error messages changed format between
        // major versions — Node 18 emits `position N`, Node 22+ uses a
        // different shape. To keep the newline branch in
        // `positionToLineCol` covered regardless of Node version, force
        // a deterministic "position N" via a monkey-patched JSON.parse.
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            // Source `'a\nbcde'` has a newline at index 1. Position 5
            // lands on the last char, past the newline — exercises
            // both the newline branch (line +=1; column = 1) AND the
            // post-newline column increments in `positionToLineCol`.
            throw new SyntaxError('Unexpected token x at position 5');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJsonc('a\nbcde'));
            expect(err).toBeInstanceOf(JsoncParseError);
            const je = err as JsoncParseError;
            expect(je.line).toBe(2);
            expect(je.column).toBe(4);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });

    it('reports approximate line/column for malformed JSON', () => {
        try {
            parseJsonc('{\n  "a": ?\n}');
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(JsoncParseError);
            const err = e as JsoncParseError;
            expect(err.line).toBeGreaterThanOrEqual(1);
            expect(err.column).toBeGreaterThanOrEqual(1);
        }
    });

    it('handles JSON.parse errors without a "position" hint gracefully', () => {
        // Force a parse failure with no `position N` in the message by
        // monkeypatching JSON.parse for this single call. We use a fresh
        // function so the descriptor is restorable.
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            throw new Error('something broke (no position info)');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJsonc('{}'));
            expect(err).toBeInstanceOf(JsoncParseError);
            const je = err as JsoncParseError;
            expect(je.line).toBe(1);
            expect(je.column).toBe(1);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });

    it('clamps an out-of-range "position N" hint to the source length', () => {
        // A position literal far past EOF must still produce a valid
        // (line, column) pair without overflowing the source buffer.
        const realParse = JSON.parse.bind(JSON);
        const spy = (text: string) => {
            void text;
            throw new SyntaxError('Unexpected token x at position 999999');
        };
        (JSON as { parse: typeof JSON.parse }).parse = spy as typeof JSON.parse;
        try {
            const err = expectThrows(() => parseJsonc('{}'));
            expect(err).toBeInstanceOf(JsoncParseError);
            const je = err as JsoncParseError;
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
            expect(() => parseJsonc('{}')).toThrow(JsoncParseError);
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }
    });
});

describe('stripCommentsAndTrailingCommas — direct', () => {
    it('preserves length so byte offsets line up', () => {
        const src = '{"a": /* comment */ 1}';
        const out = stripCommentsAndTrailingCommas(src);
        expect(out).toHaveLength(src.length);
        // After stripping, the block comment becomes runs of spaces;
        // structural chars (quotes, braces, digits) are preserved.
        expect(out.replace(/ +/g, ' ')).toBe('{"a": 1}');
        // Comment text region is now all spaces.
        const start = src.indexOf('/*');
        const end = src.indexOf('*/') + 2;
        expect(out.slice(start, end)).toBe(' '.repeat(end - start));
    });

    it('preserves newlines inside block comments', () => {
        const src = '/*\nfoo\n*/{}';
        const out = stripCommentsAndTrailingCommas(src);
        expect(out.split('\n')).toHaveLength(3);
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
