import { describe, it, expect } from 'vitest';
import {
    classEntrySchema,
    classKindSchema,
    confidenceSchema,
    fieldEntrySchema,
    methodEntrySchema,
    methodMapValueSchema,
    mapSourceSchema,
    rosettaMapSchema,
    validateMap,
    zodPathToString,
} from './schema.js';
import { MapValidationError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';

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
});

describe('methodMapValueSchema', () => {
    it('accepts a single MethodEntry', () => {
        const m = { obfuscated: 'c', signature: '()V' };
        expect(methodMapValueSchema.parse(m)).toEqual(m);
    });

    it('accepts an array of MethodEntry', () => {
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
        expect(classEntrySchema.parse(c)).toEqual(c);
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
            frida_min_version: '16.0.0',
            frida_max_version: '17.99.99',
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
        expect(rosettaMapSchema.parse(m)).toEqual(m);
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

    it('strips unknown top-level keys (forward-compat)', () => {
        const parsed = rosettaMapSchema.parse({
            schema_version: 2,
            version_code: 1,
            app: 'a',
            version: 'v',
            classes: {},
            future_field: 'ignored',
        });
        expect((parsed as Record<string, unknown>).future_field).toBeUndefined();
    });
});

describe('validateMap', () => {
    it('returns the validated map on success', () => {
        const data: RosettaMap = {
            schema_version: 2,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: {
                        bar: { obfuscated: 'c', signature: '()V' },
                    },
                },
            },
        };
        const out = validateMap(data);
        expect(out).toEqual(data);
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
                app: 'a',
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
