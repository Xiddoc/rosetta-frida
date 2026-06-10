import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { loadMap } from '../parse/load.js';
import {
    APP_PATTERN,
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
    CAPTURED_AT_PATTERN,
    SIGNATURES_REV_PATTERN,
    classEntrySchema,
    classKindSchema,
    fieldEntrySchema,
    fieldMapSchema,
    methodEntrySchema,
    methodMapSchema,
    methodMapValueSchema,
    mapSourceSchema,
    signerSha256Schema,
    generatedFromSchema,
    mapStatusSchema,
    rosettaMapSchema,
    validateMap,
    zodPathToString,
} from './schema.js';
import { MapValidationError } from '../errors.js';

describe('classKindSchema', () => {
    it('accepts every ClassKind value', () => {
        const kinds = ['class', 'interface', 'enum', 'synthetic', 'anonymous'] as const;
        for (const k of kinds) {
            expect(classKindSchema.parse(k)).toBe(k);
        }
    });

    it('rejects unknown kinds', () => {
        expect(() => classKindSchema.parse('mixin')).toThrow();
    });

    it('rejects the removed AIDL kinds (schema 4 pure-mapping)', () => {
        expect(() => classKindSchema.parse('aidl_stub')).toThrow();
        expect(() => classKindSchema.parse('aidl_callback')).toThrow();
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
        };
        expect(mapSourceSchema.parse(src)).toEqual(src);
    });

    it('rejects the removed confidence field on a source (schema 3, strict)', () => {
        // `confidence` was dropped in schema_version 3 (#43); the strict
        // object now rejects it as an unknown key rather than carrying it.
        expect(() => mapSourceSchema.parse({ tool: 'sigmatcher', confidence: 'high' })).toThrow();
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

    it('accepts the canonical cross-client tool vocabulary (free-form; convention, not constraint)', () => {
        // IMPORTANT: `tool` is a free-form `z.string()`. The canonical
        // client-neutral vocabulary — 'sigmatcher', 'hand-authored',
        // 'rosetta-runtime-discovered' — is a CONVENTION, NOT a schema
        // constraint: the validator accepts ANY string (a framework-specific
        // spelling like 'rosetta-frida-runtime-discovered' would validate just
        // as happily). This test therefore only confirms the canonical tokens
        // are NOT accidentally rejected; it enforces nothing about what is
        // emitted. The genuine enforcing guard — that this client's sigmatcher
        // adapter emits ONLY the canonical token and never a framework-specific
        // one — lives in `tools/adapters/sigmatcher.test.ts` (pinning the value
        // we actually control, not the permissive validator).
        for (const tool of ['sigmatcher', 'hand-authored', 'rosetta-runtime-discovered']) {
            expect(mapSourceSchema.parse({ tool })).toEqual({ tool });
        }
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
            static: true,
            synthetic: false,
            is_constructor: false,
        };
        expect(methodEntrySchema.parse(m)).toEqual(m);
    });

    it('rejects missing obfuscated', () => {
        expect(() => methodEntrySchema.parse({ signature: '()V' })).toThrow();
    });

    it('rejects the removed aidl_txn field (schema 4 pure-mapping, strict)', () => {
        expect(() =>
            methodEntrySchema.parse({ obfuscated: 'c', signature: '()V', aidl_txn: 2 }),
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
            kind: 'class' as const,
            dex: 'classes6.dex',
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

    it('rejects the removed confidence field on a class entry (schema 3, strict)', () => {
        // Per-entry `confidence` was dropped in schema_version 3 (#43).
        expect(() => classEntrySchema.parse({ obfuscated: 'aaaa', confidence: 'high' })).toThrow();
    });

    it('rejects the removed aidl_descriptor / anchors fields (schema 4 pure-mapping, strict)', () => {
        expect(() =>
            classEntrySchema.parse({ obfuscated: 'aaaa', aidl_descriptor: 'com.example.IFoo' }),
        ).toThrow();
        expect(() => classEntrySchema.parse({ obfuscated: 'aaaa', anchors: ['marker'] })).toThrow();
    });
});

describe('signerSha256Schema', () => {
    it('accepts a single 64-char lowercase hex digest', () => {
        const h = 'a'.repeat(64);
        expect(signerSha256Schema.parse(h)).toBe(h);
    });

    it('accepts a non-empty array of digests (match-any)', () => {
        const arr = ['a'.repeat(64), 'b'.repeat(64)];
        expect(signerSha256Schema.parse(arr)).toEqual(arr);
    });

    it('rejects an empty array (pins no signer)', () => {
        expect(() => signerSha256Schema.parse([])).toThrow();
    });

    it('rejects an uppercase digest (bare-lowercase map value only)', () => {
        expect(() => signerSha256Schema.parse('A'.repeat(64))).toThrow();
    });

    it('rejects a colon-separated digest (no separators in the MAP value)', () => {
        // 32 "ab:" groups -> 64 hex chars with colons; the map value must be bare.
        expect(() => signerSha256Schema.parse(Array(32).fill('ab').join(':'))).toThrow();
    });

    it('rejects a wrong-length digest', () => {
        expect(() => signerSha256Schema.parse('abc')).toThrow();
    });

    it('rejects an array containing an uppercase digest', () => {
        expect(() => signerSha256Schema.parse(['a'.repeat(64), 'B'.repeat(64)])).toThrow();
    });
});

describe('generatedFromSchema', () => {
    it('accepts a 7-char abbreviated git rev', () => {
        const g = { signatures_rev: 'abcdef0' };
        expect(generatedFromSchema.parse(g)).toEqual(g);
    });

    it('accepts a 40-char full git rev', () => {
        const g = { signatures_rev: 'a'.repeat(40) };
        expect(generatedFromSchema.parse(g)).toEqual(g);
    });

    it('rejects a too-short rev (< 7)', () => {
        expect(() => generatedFromSchema.parse({ signatures_rev: 'abcde' })).toThrow();
    });

    it('rejects a too-long rev (> 40)', () => {
        expect(() => generatedFromSchema.parse({ signatures_rev: 'a'.repeat(41) })).toThrow();
    });

    it('rejects an uppercase rev', () => {
        expect(() => generatedFromSchema.parse({ signatures_rev: 'ABCDEF0' })).toThrow();
    });

    it('rejects a missing signatures_rev (required-if-present)', () => {
        expect(() => generatedFromSchema.parse({})).toThrow();
    });

    it('rejects an unknown key (strict)', () => {
        expect(() => generatedFromSchema.parse({ signatures_rev: 'abcdef0', bogus: 1 })).toThrow();
    });
});

describe('mapStatusSchema', () => {
    it('accepts the three lifecycle values', () => {
        expect(mapStatusSchema.parse('active')).toBe('active');
        expect(mapStatusSchema.parse('superseded')).toBe('superseded');
        expect(mapStatusSchema.parse('retracted')).toBe('retracted');
    });

    it('rejects an unknown status', () => {
        expect(() => mapStatusSchema.parse('deprecated')).toThrow();
    });
});

describe('CAPTURED_AT_PATTERN', () => {
    it('accepts a well-formed ISO date', () => {
        expect(CAPTURED_AT_PATTERN.test('2026-05-11')).toBe(true);
    });

    it('rejects arbitrary text', () => {
        expect(CAPTURED_AT_PATTERN.test('last tuesday')).toBe(false);
    });

    it('rejects an out-of-range month/day', () => {
        expect(CAPTURED_AT_PATTERN.test('2026-13-01')).toBe(false);
        expect(CAPTURED_AT_PATTERN.test('2026-02-32')).toBe(false);
    });

    it('rejects a non-zero-padded date', () => {
        expect(CAPTURED_AT_PATTERN.test('2026-5-1')).toBe(false);
    });
});

describe('SIGNATURES_REV_PATTERN', () => {
    it('accepts 7–40 lowercase hex', () => {
        expect(SIGNATURES_REV_PATTERN.test('abcdef0')).toBe(true);
        expect(SIGNATURES_REV_PATTERN.test('a'.repeat(40))).toBe(true);
    });

    it('rejects out-of-range lengths and uppercase', () => {
        expect(SIGNATURES_REV_PATTERN.test('abcde')).toBe(false);
        expect(SIGNATURES_REV_PATTERN.test('a'.repeat(41))).toBe(false);
        expect(SIGNATURES_REV_PATTERN.test('ABCDEF0')).toBe(false);
    });
});

describe('rosettaMapSchema', () => {
    it('accepts a minimal map', () => {
        const m = {
            schema_version: 4 as const,
            app: 'com.example.app',
            version: '1.2.3',
            version_code: 10203,
            classes: {},
        };
        expect(rosettaMapSchema.parse(m)).toEqual(m);
    });

    it('accepts a fully-populated map', () => {
        const m = {
            schema_version: 4 as const,
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

    it('rejects schema_version other than 4', () => {
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

    it('rejects a schema_version 3 map (the prior version is no longer accepted)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 3,
                app: 'com.example.app',
                version: 'b',
                version_code: 1,
                classes: {},
            }),
        ).toThrow();
    });

    it('accepts a map with an ISO captured_at date', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                captured_at: '2026-05-11',
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects a non-date captured_at (schema 3 tightening, #39)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                captured_at: 'sometime last spring',
                classes: {},
            }),
        ).toThrow();
    });

    it.each(['2026-02-30', '2026-04-31', '2025-02-29', '2026-06-31', '2026-11-31'])(
        'rejects an impossible calendar captured_at date %s (#39)',
        (captured_at) => {
            expect(() =>
                rosettaMapSchema.parse({
                    schema_version: 4,
                    app: 'com.example.app',
                    version: 'v',
                    version_code: 1,
                    captured_at,
                    classes: {},
                }),
            ).toThrow(/real calendar date/);
        },
    );

    it.each(['2024-02-29', '2026-01-31', '2026-12-31', '2026-02-28'])(
        'accepts a real calendar captured_at date %s (#39)',
        (captured_at) => {
            expect(() =>
                rosettaMapSchema.parse({
                    schema_version: 4,
                    app: 'com.example.app',
                    version: 'v',
                    version_code: 1,
                    captured_at,
                    classes: {},
                }),
            ).not.toThrow();
        },
    );

    it('accepts a signer_sha256 array (match-any, #38)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                signer_sha256: ['a'.repeat(64), 'b'.repeat(64)],
                classes: {},
            }),
        ).not.toThrow();
    });

    it('accepts a signer_sha256 array larger than MAX_SOURCES (no maxItems cap, parity)', () => {
        // The canonical schema has minItems:1 and NO maxItems on signer_sha256;
        // capping it here would make this client stricter than the schema.
        const many = Array.from({ length: MAX_SOURCES + 5 }, (_, i) =>
            i.toString(16).padStart(2, '0').repeat(32),
        );
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                signer_sha256: many,
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects an empty signer_sha256 array (minItems:1, #38)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                signer_sha256: [],
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects an uppercase signer_sha256 (bare lowercase only, #32)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                signer_sha256: 'A'.repeat(64),
                classes: {},
            }),
        ).toThrow();
    });

    it('accepts a generated_from pointer (#36)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                generated_from: { signatures_rev: 'abcdef0' },
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects a generated_from with a bad rev (#36)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                generated_from: { signatures_rev: 'nothex!' },
                classes: {},
            }),
        ).toThrow();
    });

    it('accepts a status enum value and superseded_by (#40)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'superseded',
                superseded_by: 2,
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects an unknown status value (#40)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'deprecated',
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects a negative superseded_by (#40)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'superseded',
                superseded_by: -1,
                classes: {},
            }),
        ).toThrow();
    });

    it("rejects status: 'superseded' without superseded_by (#40 cross-field)", () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'superseded',
                classes: {},
            }),
        ).toThrow(/superseded_by is required when status is 'superseded'/);
    });

    it('rejects superseded_by on an active (status absent) map (#40 cross-field)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                superseded_by: 2,
                classes: {},
            }),
        ).toThrow(/superseded_by is only allowed when status is 'superseded'/);
    });

    it('rejects superseded_by on an explicitly active map (#40 cross-field)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'active',
                superseded_by: 2,
                classes: {},
            }),
        ).toThrow(/superseded_by is only allowed when status is 'superseded'/);
    });

    it('rejects superseded_by on a retracted map (#40 cross-field)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'retracted',
                superseded_by: 2,
                classes: {},
            }),
        ).toThrow(/superseded_by is only allowed when status is 'superseded'/);
    });

    it('accepts a retracted map with no superseded_by (#40 cross-field)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'com.example.app',
                version: 'v',
                version_code: 1,
                status: 'retracted',
                classes: {},
            }),
        ).not.toThrow();
    });

    it('rejects a missing version_code', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
                app: 'a',
                version: 'b',
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects a non-integer version_code', () => {
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
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
                schema_version: 4,
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
                schema_version: 4,
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
                schema_version: 4,
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
                schema_version: 4,
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
                schema_version: 4,
                version_code: 1,
                version: '1',
                classes: {},
            }),
        ).toThrow();
    });

    it('rejects missing version', () => {
        expect(() =>
            rosettaMapSchema.parse({ schema_version: 4, version_code: 1, app: 'a', classes: {} }),
        ).toThrow();
    });

    it('rejects missing classes', () => {
        expect(() =>
            rosettaMapSchema.parse({ schema_version: 4, version_code: 1, app: 'a', version: '1' }),
        ).toThrow();
    });

    it('rejects an unknown top-level key (strict; mirrors additionalProperties: false)', () => {
        // The fixed-shape objects are STRICT — a typo'd / unknown sibling key
        // fails loudly instead of being silently stripped (frida#17 M6).
        expect(() =>
            rosettaMapSchema.parse({
                schema_version: 4,
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
                schema_version: 4,
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
                schema_version: 4,
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
            schema_version: 4,
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
                schema_version: 5,
                version_code: 1,
                app: 'com.example.app',
                version: 'v',
                classes: {},
            }),
        ).toThrow();
    });
});

describe('client_hints', () => {
    it('accepts a nested client_hints sub-object', () => {
        const m = {
            ...baseMap(),
            client_hints: { frida_min_version: '16.0.0', frida_max_version: '17.99.99' },
        };
        expect(rosettaMapSchema.parse(m)).toEqual(m);
    });

    it('accepts a partial / empty client_hints', () => {
        expect(() => rosettaMapSchema.parse({ ...baseMap(), client_hints: {} })).not.toThrow();
        expect(() =>
            rosettaMapSchema.parse({
                ...baseMap(),
                client_hints: { frida_min_version: '16.0.0' },
            }),
        ).not.toThrow();
    });

    it('rejects an unknown key inside client_hints (strict)', () => {
        expect(() =>
            rosettaMapSchema.parse({
                ...baseMap(),
                client_hints: { frida_min_version: '16.0.0', xposed_min_version: '1' },
            }),
        ).toThrow();
    });

    it('rejects the legacy TOP-LEVEL frida_min_version (migrated to client_hints)', () => {
        // Top level is strict: the pre-migration spelling must now fail so a
        // stale map is caught rather than silently dropping the hint.
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), frida_min_version: '16.0.0' }),
        ).toThrow();
        expect(() =>
            rosettaMapSchema.parse({ ...baseMap(), frida_max_version: '17.99.99' }),
        ).toThrow();
    });
});

describe('validateMap', () => {
    it('returns the validated (normalised) map on success', () => {
        const data = {
            schema_version: 4 as const,
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
                schema_version: 4,
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
                schema_version: 4,
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

    // L6 — a wrong-but-numeric schema_version gets a dedicated, actionable
    // message naming found-vs-expected and pointing at `rosetta migrate`.
    it('gives an older schema_version a migration-hint message', () => {
        try {
            validateMap({
                schema_version: 1,
                app: 'com.example.app',
                version: '1.0.0',
                version_code: 1,
                classes: {},
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            // Names the found version, the expected version, and the remedy.
            expect(err.message).toMatch(/schema_version 1/);
            expect(err.message).toMatch(/supports schema_version 4/);
            // An older map is re-emitted at the current version (the
            // upgrade-the-library remedy is for NEWER maps only).
            expect(err.message).toMatch(/re-emit the map at version 4/);
            // `rosetta migrate` is named only as a PLANNED command.
            expect(err.message).toMatch(/rosetta migrate/);
            expect(err.message).toMatch(/planned/i);
            // Single, focused issue scoped to the schema_version field.
            expect(err.issues).toHaveLength(1);
            expect(err.issues[0]?.path).toBe('schema_version');
        }
    });

    it('tells a newer schema_version to UPGRADE the library (cannot downgrade)', () => {
        try {
            validateMap({
                schema_version: 5,
                app: 'com.example.app',
                version: '1.0.0',
                version_code: 1,
                classes: {},
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            // Names the found version and the supported version.
            expect(err.message).toMatch(/schema_version 5/);
            expect(err.message).toMatch(/supports schema_version 4/);
            // A newer map cannot be downgraded — the remedy is to upgrade the
            // install, NOT to re-emit at the current version.
            expect(err.message).toMatch(/upgrade rosetta-frida/i);
            // `rosetta migrate` is named only as a PLANNED command.
            expect(err.message).toMatch(/rosetta migrate/);
            expect(err.message).toMatch(/planned/i);
            // Symmetric with the older-version test: single, focused issue.
            expect(err.issues).toHaveLength(1);
            expect(err.issues[0]?.path).toBe('schema_version');
        }
    });

    it('does NOT use the migration-hint path for a NaN schema_version', () => {
        // `NaN` is `typeof 'number'` but names no version: it must fall through
        // to the normal Zod issue list (the literal gate), not the
        // migration-hint path.
        try {
            validateMap({
                schema_version: NaN,
                app: 'com.example.app',
                version: '1.0.0',
                version_code: 1,
                classes: {},
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.message).not.toMatch(/rosetta migrate/);
        }
    });

    it('does NOT use the migration-hint path for a missing/non-numeric schema_version', () => {
        // A missing schema_version is a normal validation failure, not a
        // version mismatch — it must fall through to the generic issue list
        // (so the migration hint is not misapplied to maps that never named a
        // version).
        try {
            validateMap({
                app: 'com.example.app',
                version: '1.0.0',
                version_code: 1,
                classes: {},
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.message).not.toMatch(/rosetta migrate/);
        }
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
        schema_version: 4,
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
        // A single un-dotted token is not a package name.
        expect(APP_PATTERN.test('myapp')).toBe(false);
        expect(APP_PATTERN.test('com.')).toBe(false);
        expect(APP_PATTERN.test('.com.example')).toBe(false);
        expect(APP_PATTERN.test('1com.example')).toBe(false);
        expect(APP_PATTERN.test('com..example')).toBe(false);
    });

    it('rejects a segment that does not start with a letter (parity)', () => {
        // Every dotted segment must begin with a letter — the tightened
        // canonical pattern. A digit-first interior segment is rejected.
        expect(APP_PATTERN.test('com.2example.app')).toBe(false);
        expect(APP_PATTERN.test('com.example.2app')).toBe(false);
        // ...but a letter-first segment with later digits is fine.
        expect(APP_PATTERN.test('com.example.app')).toBe(true);
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

describe('published example map (canonical-example invariant)', () => {
    // The map a new contributor copies MUST always validate through the
    // production validator/loader. Reading the real file (no fs mock) guards
    // both the validator and the sample itself against drift — e.g. the
    // client_hints migration.
    const examplePath = path.resolve(import.meta.dirname, '../../maps/com.example.app/30405.json');

    it('validates through validateMap', () => {
        const parsed = JSON.parse(readFileSync(examplePath, 'utf8')) as unknown;
        expect(() => validateMap(parsed)).not.toThrow();
        expect(validateMap(parsed).client_hints?.frida_min_version).toBe('16.0.0');
    });

    it('validates through the production loadMap (JSON source)', async () => {
        const source = readFileSync(examplePath, 'utf8');
        const map = await loadMap(source);
        expect(map.app).toBe('com.example.app');
        expect(map.version_code).toBe(30405);
    });
});
