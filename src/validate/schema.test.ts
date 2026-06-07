import { describe, it, expect } from 'vitest';
import {
    APP_PATTERN,
    MAX_ANCHORS,
    MAX_APP_LEN,
    MAX_CLASSES,
    MAX_FIELDS_PER_CLASS,
    MAX_FREE_STRING_LEN,
    MAX_METHODS_PER_CLASS,
    MAX_METHOD_OVERLOADS,
    MAX_SHORT_NAME_LEN,
    MAX_SIGNATURE_LEN,
    MAX_SOURCES,
    MAX_VERSION_CODE,
    MAX_VERSION_LEN,
    RESERVED_RECORD_KEYS,
    SIGNER_SHA256_PATTERN,
    classEntrySchema,
    classKindSchema,
    confidenceSchema,
    fieldEntrySchema,
    fieldMapSchema,
    methodEntrySchema,
    methodMapSchema,
    methodMapValueSchema,
    mapSourceSchema,
    rosettaMapSchema,
    validateMap,
    zodPathToString,
} from './schema.js';
import { MapValidationError } from '../errors.js';

describe('confidenceSchema', () => {
    it('accepts all three confidence values', () => {
        expect(confidenceSchema.parse('high')).toBe('high');
        expect(confidenceSchema.parse('medium')).toBe('medium');
        expect(confidenceSchema.parse('low')).toBe('low');
    });

    it('rejects anything else', () => {
        expect(() => confidenceSchema.parse('certain')).toThrow();
        expect(() => confidenceSchema.parse(0)).toThrow();
    });
});

describe('classKindSchema', () => {
    it('accepts every ClassKind value', () => {
        const kinds = [
            'class',
            'interface',
            'enum',
            'aidl_stub',
            'aidl_callback',
            'synthetic',
            'anonymous',
        ] as const;
        for (const k of kinds) {
            expect(classKindSchema.parse(k)).toBe(k);
        }
    });

    it('rejects unknown kinds', () => {
        expect(() => classKindSchema.parse('mixin')).toThrow();
    });
});

describe('mapSourceSchema', () => {
    it('accepts a minimal source (tool only)', () => {
        expect(mapSourceSchema.parse({ tool: 'sigmatcher' })).toEqual({ tool: 'sigmatcher' });
    });

    it('accepts a fully-populated source', () => {
        const src = {
            tool: 'sigmatcher',
            config: 'sig.yaml',
            classes: 12,
            notes: 'verified',
            confidence: 'high' as const,
        };
        expect(mapSourceSchema.parse(src)).toEqual(src);
    });

    it('rejects a non-string tool', () => {
        expect(() => mapSourceSchema.parse({ tool: 0 })).toThrow();
    });

    it('rejects a non-integer classes count', () => {
        expect(() => mapSourceSchema.parse({ tool: 't', classes: 1.5 })).toThrow();
    });

    it('rejects an unknown key (strict)', () => {
        expect(() => mapSourceSchema.parse({ tool: 't', bogus: 1 })).toThrow();
    });
});

describe('methodEntrySchema', () => {
    it('accepts the minimal form (obfuscated + signature)', () => {
        const m = { obfuscated: 'c', signature: '()V' };
        expect(methodEntrySchema.parse(m)).toEqual(m);
    });

    it('accepts every optional field present', () => {
        const m = {
            obfuscated: 'c',
            signature: '(Landroid/os/Bundle;)V',
            aidl_txn: 2,
            static: true,
            synthetic: false,
            is_constructor: false,
        };
        expect(methodEntrySchema.parse(m)).toEqual(m);
    });

    it('rejects missing obfuscated', () => {
        expect(() => methodEntrySchema.parse({ signature: '()V' })).toThrow();
    });

    it('rejects non-integer aidl_txn', () => {
        expect(() =>
            methodEntrySchema.parse({ obfuscated: 'c', signature: '()V', aidl_txn: 1.5 }),
        ).toThrow();
    });

    it('rejects a typo key (strict; e.g. signatuer)', () => {
        expect(() =>
            methodEntrySchema.parse({ obfuscated: 'c', signature: '()V', signatuer: '()V' }),
        ).toThrow();
    });
});

describe('fieldEntrySchema', () => {
    it('accepts a minimal field (non-static implicit)', () => {
        const f = { obfuscated: 'a', type: 'Ljava/lang/String;' };
        expect(fieldEntrySchema.parse(f)).toEqual(f);
    });

    it('accepts a static field', () => {
        const f = { obfuscated: 'b', type: 'I', static: true };
        expect(fieldEntrySchema.parse(f)).toEqual(f);
    });

    it('rejects missing type', () => {
        expect(() => fieldEntrySchema.parse({ obfuscated: 'a' })).toThrow();
    });

    it('rejects an unknown key (strict)', () => {
        expect(() => fieldEntrySchema.parse({ obfuscated: 'a', type: 'I', bogus: true })).toThrow();
    });
});

describe('methodMapValueSchema', () => {
    it('normalises a single MethodEntry to a one-element array', () => {
        const m = { obfuscated: 'c', signature: '()V' };
        expect(methodMapValueSchema.parse(m)).toEqual([m]);
    });

    it('accepts an array of MethodEntry unchanged', () => {
        const m = [
            { obfuscated: 'c', signature: '()V' },
            { obfuscated: 'd', signature: '(I)V' },
        ];
        expect(methodMapValueSchema.parse(m)).toEqual(m);
    });

    it('rejects an array containing an invalid entry', () => {
        expect(() => methodMapValueSchema.parse([{ obfuscated: 'c' }])).toThrow();
    });

    it('rejects a number', () => {
        expect(() => methodMapValueSchema.parse(42)).toThrow();
    });
});

describe('classEntrySchema', () => {
    it('accepts the minimal form (obfuscated only)', () => {
        const c = { obfuscated: 'aaaa' };
        expect(classEntrySchema.parse(c)).toEqual(c);
    });

    it('accepts every optional field present', () => {
        const c = {
            obfuscated: 'aaaa',
            extends: 'bbbb',
            kind: 'aidl_stub' as const,
            dex: 'classes6.dex',
            aidl_descriptor: 'com.example.app.IRemoteService',
            anchors: ['hello', 'world'],
            methods: {
                m1: { obfuscated: 'a', signature: '()V' },
                m2: [
                    { obfuscated: 'b', signature: '(I)V' },
                    { obfuscated: 'c', signature: '(I;I)V' },
                ],
            },
            fields: {
                f: { obfuscated: 'x', type: 'I' },
                S: { obfuscated: 'y', type: 'I', static: true },
            },
            source: 'sigmatcher',
            confidence: 'high' as const,
        };
        // The single-overload `m1` is normalised to a one-element array.
        expect(classEntrySchema.parse(c)).toEqual({
            ...c,
            methods: {
                m1: [{ obfuscated: 'a', signature: '()V' }],
                m2: [
                    { obfuscated: 'b', signature: '(I)V' },
                    { obfuscated: 'c', signature: '(I;I)V' },
                ],
            },
        });
    });

    it('rejects a class without obfuscated', () => {
        expect(() => classEntrySchema.parse({ kind: 'class' })).toThrow();
    });

    it('rejects unknown class kind via the leaf union', () => {
        expect(() => classEntrySchema.parse({ obfuscated: 'aaaa', kind: 'not-a-kind' })).toThrow();
    });
});

describe('rosettaMapSchema', () => {
    it('accepts a minimal map', () => {
        const m = {
            schema_version: 2 as const,
            app: 'com.example.app',
            version: '1.2.3',
            version_code: 10203,
            classes: {},
        };
        expect(rosettaMapSchema.parse(m)).toEqual(m);
    });

    it('accepts a fully-populated map', () => {
        const m = {
            schema_version: 2 as const,
            app: 'com.example.app',
            version: '3.4.5',
            version_code: 30405,
            captured_at: '2026-05-11',
            signer_sha256: 'a'.repeat(64),
            client_hints: {
                frida_min_version: '16.0.0',
                frida_max_version: '17.99.99',
            },
            sources: [
                { tool: 'sigmatcher', classes: 12 },
                { tool: 'hand-authored', notes: 'verified' },
            ],
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: {
                        bar: { obfuscated: 'c', signature: '()V' },
                    },
                },
            },
        };
        // `bar` is normalised to a one-element array on the way in.
        expect(rosettaMapSchema.parse(m)).toEqual({
            ...m,
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: { bar: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
    });

    it('rejects schema_version other than 2', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 1,
                app: 'a',
                version: 'b',
                version_code: 1,
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects a missing version_code', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'a',
                version: 'b',
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects a non-integer version_code', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'a',
                version: 'b',
                version_code: 1.5,
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects version_code above MAX_VERSION_CODE (2^53)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'com.example.app',
                version: 'v',
                version_code: MAX_VERSION_CODE + 1,
                classes: {},
            }),
        ).toThrow();
    });

    it('accepts version_code exactly at MAX_VERSION_CODE (2^53 − 1)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'com.example.app',
                version: 'v',
                version_code: MAX_VERSION_CODE,
                classes: {},
            }),
        ).not.toThrow();
    });

    it.each([
        ['2^31 − 1 (legacy int32 max)', 2_147_483_647],
        ['2^31 (just past int32)', 2_147_483_648],
        ['2^32 (versionCodeMajor = 1)', 4_294_967_296],
    ])('accepts a 64-bit longVersionCode: %s', (_label, code) => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'com.example.app',
                version: 'v',
                version_code: code,
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects a negative version_code', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                app: 'com.example.app',
                version: 'v',
                version_code: -1,
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects missing app', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                version_code: 1,
                version: '1',
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects missing version', () => {
        expect(() =>
            rosettaMapSchema.parse({ schema_version: 2, version_code: 1, app: 'a', classes: {} }),
        ).toThrow();
    });

    it('rejects missing classes', () => {
        expect(() =>
            rosettaMapSchema.parse({ schema_version: 2, version_code: 1, app: 'a', version: '1' }),
        ).toThrow();
    });

    it('rejects an unknown top-level key (strict; mirrors additionalProperties: false)', () => {
        // The fixed-shape objects are STRICT — a typo'd / unknown sibling key
        // fails loudly instead of being silently stripped (frida#17 M6).
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                version_code: 1,
                app: 'com.example.app',
                version: 'v',
                classes: {},
                future_field: 'rejected',
            }),
        ).toThrow();
    });

    it('rejects an unknown key on a class entry (strict)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                version_code: 1,
                app: 'com.example.app',
                version: 'v',
                classes: { IFoo: { obfuscated: 'aaaa', typo_field: 1 } },
            }),
        ).toThrow();
    });

    it('rejects a whitespace-only version (frida#17 M17)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 2,
                version_code: 1,
                app: 'com.example.app',
                version: '   ',
                classes: {},
            }),
        ).toThrow();
    });

    it('accepts a version with surrounding whitespace as long as it has a non-space char', () => {
        // The check is "contains a non-whitespace character", not "is trimmed".
        // The original string is preserved (not mutated).
        const parsed = rosettaMapSchema.parse({
            schema_version: 2,
            version_code: 1,
            app: 'com.example.app',
            version: ' 1.2.3 ',
            classes: {},
        });
        expect(parsed.version).toBe(' 1.2.3 ');
    });

    it('hard-rejects a NEWER schema_version (no cross-version forward-compat)', () => {
        // ...but strict on the version key itself: a newer-format map is
        // rejected, not best-effort read. This is the reconciled story.
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 3,
                version_code: 1,
                app: 'com.example.app',
                version: 'v',
                classes: {},
            }),
        ).toThrow();
    });
});

describe('validateMap', () => {
    it('returns the validated (normalised) map on success', () => {
        const data = {
            schema_version: 2 as const,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: {
                        // Authored single-overload; normalised to an array.
                        bar: { obfuscated: 'c', signature: '()V' },
                    },
                },
            },
        };
        const out = validateMap(data);
        expect(out.classes.IFoo?.methods?.bar).toEqual([{ obfuscated: 'c', signature: '()V' }]);
        expect(out.app).toBe('com.example.app');
    });

    it('throws MapValidationError with structured issues on failure', () => {
        try {
            validateMap({
                schema_version: 2,
                version_code: 1,
                app: 'a',
                version: 'v',
                classes: {
                    IFoo: {
                        // missing obfuscated
                        methods: {
                            bar: { obfuscated: 'c' /* missing signature */ },
                        },
                    },
                },
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.issues.length).toBeGreaterThan(0);
            // Each issue must carry a string path and message.
            for (const iss of err.issues) {
                expect(typeof iss.path).toBe('string');
                expect(typeof iss.message).toBe('string');
            }
            // The path of the missing obfuscated field somewhere mentions IFoo.
            const paths = err.issues.map((i) => i.path).join(' | ');
            expect(paths).toMatch(/IFoo/);
        }
    });

    it('summary message uses singular "1 issue" for a single problem', () => {
        try {
            validateMap({
                schema_version: 2,
                version_code: 1,
                app: 'com.example.app',
                version: 'v',
                classes: 'not-an-object',
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.message).toMatch(/1 issue\)/);
        }
    });

    it('summary message uses plural for multiple problems', () => {
        try {
            validateMap({
                // missing schema_version, app, version, classes — many issues.
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.message).toMatch(/\d+ issues\)/);
            expect(err.issues.length).toBeGreaterThan(1);
        }
    });

    it('rejects entirely non-object inputs', () => {
        expect(() => validateMap('a string')).toThrow(MapValidationError);
        expect(() => validateMap(null)).toThrow(MapValidationError);
        expect(() => validateMap(42)).toThrow(MapValidationError);
    });
});

describe('zodPathToString', () => {
    it('joins string segments with dots', () => {
        expect(zodPathToString(['a', 'b', 'c'])).toBe('a.b.c');
    });

    it('coerces numeric segments to their decimal string', () => {
        expect(zodPathToString(['xs', 2, 'name'])).toBe('xs.2.name');
    });

    it('handles symbol segments via String()', () => {
        const sym = Symbol('s');
        const out = zodPathToString(['root', sym]);
        // Just check the symbol description got included, not exact format.
        expect(out).toMatch(/^root\.Symbol\(s\)$/);
    });

    it('returns the empty string for the root path', () => {
        expect(zodPathToString([])).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Security input bounds (M1)
// ---------------------------------------------------------------------------

/** A valid baseline map; tests mutate a clone to exercise one bound at a time. */
function baseMap(): Record<string, unknown> {
    return {
        schema_version: 2,
        app: 'com.example.app',
        version: '1.2.3',
        version_code: 10203,
        classes: {},
    };
}

describe('exported cap constants', () => {
    it('match the canonical schema caps', () => {
        expect(MAX_CLASSES).toBe(50_000);
        expect(MAX_METHODS_PER_CLASS).toBe(5_000);
        expect(MAX_FIELDS_PER_CLASS).toBe(5_000);
        expect(MAX_METHOD_OVERLOADS).toBe(200);
        expect(MAX_ANCHORS).toBe(1_000);
        expect(MAX_SOURCES).toBe(100);
        expect(MAX_SHORT_NAME_LEN).toBe(512);
        expect(MAX_SIGNATURE_LEN).toBe(4_096);
        expect(MAX_APP_LEN).toBe(256);
        expect(MAX_VERSION_LEN).toBe(256);
        expect(MAX_FREE_STRING_LEN).toBe(4_096);
        expect(MAX_VERSION_CODE).toBe(Number.MAX_SAFE_INTEGER);
        expect(RESERVED_RECORD_KEYS).toEqual(['__proto__', 'constructor', 'prototype']);
    });
});

describe('app pattern', () => {
    it('accepts dotted package names', () => {
        expect(APP_PATTERN.test('com.example.app')).toBe(true);
        expect(APP_PATTERN.test('a.b')).toBe(true);
        expect(APP_PATTERN.test('com.example_app.v2')).toBe(true);
    });

    it('rejects single-segment / malformed names', () => {
        expect(APP_PATTERN.test('a')).toBe(false);
        expect(APP_PATTERN.test('com.')).toBe(false);
        expect(APP_PATTERN.test('.com.example')).toBe(false);
        expect(APP_PATTERN.test('1com.example')).toBe(false);
        expect(APP_PATTERN.test('com..example')).toBe(false);
    });

    it('rejects a bad app pattern at the map level', () => {
        expect(() => rosettaMapSchema.parse({ ...baseMap(), app: 'not-a-package' })).toThrow();
        expect(() => rosettaMapSchema.parse({ ...baseMap(), app: 'single' })).toThrow();
    });

    it('rejects an over-length app name', () => {
        const app = `com.${'a'.repeat(MAX_APP_LEN)}`;
        expect(() => rosettaMapSchema.parse({ ...baseMap(), app })).toThrow();
    });
});

describe('signer_sha256 enforcement', () => {
    it('accepts a 64-char lowercase hex digest', () => {
        const ok = 'a'.repeat(64);
        expect(SIGNER_SHA256_PATTERN.test(ok)).toBe(true);
        expect(() => rosettaMapSchema.parse({ ...baseMap(), signer_sha256: ok })).not.toThrow();
    });

    it('rejects uppercase, wrong-length, or non-hex digests', () => {
        expect(SIGNER_SHA256_PATTERN.test('A'.repeat(64))).toBe(false);
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), signer_sha256: 'A'.repeat(64) }),
        ).toThrow();
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), signer_sha256: 'a'.repeat(63) }),
        ).toThrow();
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), signer_sha256: `${'a'.repeat(63)}z` }),
        ).toThrow();
    });
});

describe('string length caps', () => {
    it('rejects an over-length version label', () => {
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), version: 'v'.repeat(MAX_VERSION_LEN + 1) }),
        ).toThrow();
    });

    it('rejects an over-length obfuscated short name', () => {
        expect(() =>
            classEntrySchema.parse({ obfuscated: 'a'.repeat(MAX_SHORT_NAME_LEN + 1) }),
        ).toThrow();
    });

    it('accepts an obfuscated name exactly at the cap', () => {
        expect(() =>
            classEntrySchema.parse({ obfuscated: 'a'.repeat(MAX_SHORT_NAME_LEN) }),
        ).not.toThrow();
    });

    it('rejects an over-length method signature', () => {
        expect(() =>
            methodEntrySchema.parse({
                obfuscated: 'c',
                signature: `(${'I'.repeat(MAX_SIGNATURE_LEN)})V`,
            }),
        ).toThrow();
    });

    it('rejects an over-length field type', () => {
        expect(() =>
            fieldEntrySchema.parse({ obfuscated: 'a', type: 'L'.repeat(MAX_SIGNATURE_LEN + 1) }),
        ).toThrow();
    });

    it('rejects an over-length free-form source note', () => {
        expect(() =>
            mapSourceSchema.parse({ tool: 't', notes: 'x'.repeat(MAX_FREE_STRING_LEN + 1) }),
        ).toThrow();
    });

    it('rejects an over-length extends string (cap is MAX_FREE_STRING_LEN = 4096)', () => {
        expect(() =>
            classEntrySchema.parse({
                obfuscated: 'aaaa',
                extends: 'a'.repeat(MAX_FREE_STRING_LEN + 1),
            }),
        ).toThrow();
    });

    it('accepts an extends string exactly at MAX_FREE_STRING_LEN (4096)', () => {
        expect(() =>
            classEntrySchema.parse({
                obfuscated: 'aaaa',
                extends: 'a'.repeat(MAX_FREE_STRING_LEN),
            }),
        ).not.toThrow();
    });

    it('rejects an over-length anchor string', () => {
        expect(() =>
            classEntrySchema.parse({
                obfuscated: 'aaaa',
                anchors: ['x'.repeat(MAX_FREE_STRING_LEN + 1)],
            }),
        ).toThrow();
    });
});

describe('cardinality caps', () => {
    function manyKeys(n: number, makeValue: (i: number) => unknown): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) out[`k${i}`] = makeValue(i);
        return out;
    }

    it('rejects more than MAX_CLASSES classes', () => {
        const classes = manyKeys(MAX_CLASSES + 1, (i) => ({ obfuscated: `o${i}` }));
        expect(() => classMapParse(classes)).toThrow();
    });

    function classMapParse(classes: Record<string, unknown>): unknown {
        return rosettaMapSchema.parse({ ...baseMap(), classes });
    }

    it('accepts exactly MAX_CLASSES classes', () => {
        const classes = manyKeys(MAX_CLASSES, (i) => ({ obfuscated: `o${i}` }));
        expect(() => classMapParse(classes)).not.toThrow();
    });

    it('rejects more than MAX_METHODS_PER_CLASS methods', () => {
        const methods = manyKeys(MAX_METHODS_PER_CLASS + 1, () => ({
            obfuscated: 'c',
            signature: '()V',
        }));
        expect(() => methodMapSchema.parse(methods)).toThrow();
    });

    it('rejects more than MAX_FIELDS_PER_CLASS fields', () => {
        const fields = manyKeys(MAX_FIELDS_PER_CLASS + 1, () => ({ obfuscated: 'a', type: 'I' }));
        expect(() => fieldMapSchema.parse(fields)).toThrow();
    });

    it('rejects more than MAX_METHOD_OVERLOADS overloads', () => {
        const overloads = Array.from({ length: MAX_METHOD_OVERLOADS + 1 }, () => ({
            obfuscated: 'c',
            signature: '()V',
        }));
        expect(() => methodMapValueSchema.parse(overloads)).toThrow();
    });

    it('accepts exactly MAX_METHOD_OVERLOADS overloads', () => {
        const overloads = Array.from({ length: MAX_METHOD_OVERLOADS }, () => ({
            obfuscated: 'c',
            signature: '()V',
        }));
        expect(() => methodMapValueSchema.parse(overloads)).not.toThrow();
    });

    it('rejects more than MAX_ANCHORS anchors', () => {
        const anchors = Array.from({ length: MAX_ANCHORS + 1 }, (_, i) => `a${i}`);
        expect(() => classEntrySchema.parse({ obfuscated: 'aaaa', anchors })).toThrow();
    });

    it('rejects more than MAX_SOURCES sources', () => {
        const sources = Array.from({ length: MAX_SOURCES + 1 }, () => ({ tool: 'sigmatcher' }));
        expect(() => rosettaMapSchema.parse({ ...baseMap(), sources })).toThrow();
    });
});

describe('reserved-key rejection', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        it(`rejects '${key}' as a class key`, () => {
            const classes: Record<string, unknown> = {};
            // Define via descriptor so '__proto__' lands as an own enumerable key
            // rather than mutating the prototype.
            Object.defineProperty(classes, key, {
                value: { obfuscated: 'aaaa' },
                enumerable: true,
                configurable: true,
                writable: true,
            });
            expect(() => rosettaMapSchema.parse({ ...baseMap(), classes })).toThrow();
        });

        it(`rejects '${key}' as a method key`, () => {
            const methods: Record<string, unknown> = {};
            Object.defineProperty(methods, key, {
                value: { obfuscated: 'c', signature: '()V' },
                enumerable: true,
                configurable: true,
                writable: true,
            });
            expect(() => methodMapSchema.parse(methods)).toThrow();
        });

        it(`rejects '${key}' as a field key`, () => {
            const fields: Record<string, unknown> = {};
            Object.defineProperty(fields, key, {
                value: { obfuscated: 'a', type: 'I' },
                enumerable: true,
                configurable: true,
                writable: true,
            });
            expect(() => fieldMapSchema.parse(fields)).toThrow();
        });
    }

    it('reports the reserved key in the issue path', () => {
        const classes: Record<string, unknown> = {};
        Object.defineProperty(classes, 'prototype', {
            value: { obfuscated: 'aaaa' },
            enumerable: true,
            configurable: true,
            writable: true,
        });
        try {
            validateMap({ ...baseMap(), classes });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            const paths = err.issues.map((i) => i.path).join(' | ');
            expect(paths).toMatch(/prototype/);
        }
    });

    it('still accepts a normal, non-reserved map', () => {
        const m = {
            ...baseMap(),
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: { bar: { obfuscated: 'c', signature: '()V' } },
                    fields: { baz: { obfuscated: 'a', type: 'I' } },
                },
            },
        };
        expect(() => validateMap(m)).not.toThrow();
    });
});
