/**
 * Tests for the sigmatcher → RosettaMap adapter.
 *
 * Coverage target: 100% (lines / branches / functions / statements).
 * Every branch in `sigmatcher.ts` is exercised by at least one named
 * scenario below.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { sigmatcherRawToRosettaMap, type SigmatcherAdapterOptions } from './sigmatcher.js';
import { MapValidationError, RosettaError } from '../../src/errors.js';
import type { MethodEntry, RosettaMapInput } from '../../src/types/map.js';

const BASE_OPTIONS: SigmatcherAdapterOptions = {
    app: 'com.example.testapp',
    version: '1.0.0',
    versionCode: 100,
};

describe('sigmatcherRawToRosettaMap — single class', () => {
    it('emits a minimal map for one class with one method', () => {
        const raw = {
            BlobCache: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'get',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                        new: {
                            name: 'c',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                    },
                ],
                matched_fields: [],
                exports: [],
            },
        };

        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);

        expect(map.schema_version).toBe(4);
        expect(map.app).toBe('com.example.testapp');
        expect(map.version).toBe('1.0.0');
        expect(map.version_code).toBe(100);
        expect(map.classes).toHaveProperty('com.example.testapp.BlobCache');
        const cls = map.classes['com.example.testapp.BlobCache'];
        expect(cls).toBeDefined();
        expect(cls!.obfuscated).toBe('cccc');
        expect(cls!.source).toBe('sigmatcher');
        expect(cls!.methods).toEqual({
            get: { obfuscated: 'c', signature: '(Ljava/lang/String;)Ljava/lang/Object;' },
        });
        expect(map.sources).toEqual([{ tool: 'sigmatcher', classes: 1 }]);
    });

    it('composes the real FQN by joining package + name with a dot', () => {
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(Object.keys(map.classes)).toEqual(['com.example.testapp.X']);
    });
});

describe('sigmatcherRawToRosettaMap — multi-overload remerging', () => {
    it('collapses two definitions that map to the same real method name', () => {
        const raw = {
            put_2arg: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'put',
                            argument_types: 'Ljava/lang/String;Ljava/lang/Object;',
                            return_type: 'V',
                        },
                        new: {
                            name: 'd',
                            argument_types: 'Ljava/lang/String;Ljava/lang/Object;',
                            return_type: 'V',
                        },
                    },
                ],
                matched_fields: [],
            },
            put_3arg: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'put',
                            argument_types: 'Ljava/lang/String;Ljava/lang/Object;J',
                            return_type: 'V',
                        },
                        new: {
                            name: 'e',
                            argument_types: 'Ljava/lang/String;Ljava/lang/Object;J',
                            return_type: 'V',
                        },
                    },
                ],
                matched_fields: [],
            },
        };

        const map = sigmatcherRawToRosettaMap(raw, {
            ...BASE_OPTIONS,
            methodNameMap: {
                put_2arg: 'put',
                put_3arg: 'put',
            },
        });

        const cls = map.classes['com.example.testapp.BlobCache']!;
        expect(Array.isArray(cls.methods!['put'])).toBe(true);
        const overloads = cls.methods!['put'] as Array<{ obfuscated: string; signature: string }>;
        expect(overloads).toHaveLength(2);
        expect(overloads.map((o) => o.obfuscated).sort()).toEqual(['d', 'e']);
        expect(overloads.map((o) => o.signature).sort()).toEqual([
            '(Ljava/lang/String;Ljava/lang/Object;)V',
            '(Ljava/lang/String;Ljava/lang/Object;J)V',
        ]);
    });

    it('keeps single-overload methods in the scalar (non-array) form', () => {
        const raw = {
            get: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'get',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                        new: {
                            name: 'c',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        // The adapter EMITS the authoring (input) shape — `RosettaMapInput` —
        // not the normalised in-memory `RosettaMap`. The previous code lied
        // with `as MethodMap`/`as RosettaMap`; the return type now advertises
        // the scalar-or-array `methods` form directly, so no cast is needed.
        expectTypeOf(map).toEqualTypeOf<RosettaMapInput>();
        const cls = map.classes['com.example.testapp.BlobCache']!;
        // `methods` value is the authoring union (`MethodEntry | MethodEntry[]`),
        // which is exactly why the scalar assertion below is sound at the type
        // level — not hidden behind a cast.
        expectTypeOf(cls.methods!['get']).toEqualTypeOf<MethodEntry | MethodEntry[]>();
        expect(Array.isArray(cls.methods!['get'])).toBe(false);
        expect(cls.methods!['get']).toEqual({
            obfuscated: 'c',
            signature: '(Ljava/lang/String;)Ljava/lang/Object;',
        });
    });

    it('falls back to original.name when methodNameMap has no entry for the definition', () => {
        const raw = {
            DefThatIsNotInMap: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'evict',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'V',
                        },
                        new: { name: 'f', argument_types: 'Ljava/lang/String;', return_type: 'V' },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.BlobCache']!;
        expect(cls.methods!['evict']).toEqual({
            obfuscated: 'f',
            signature: '(Ljava/lang/String;)V',
        });
    });

    it('falls back to defName when neither methodNameMap nor original.name yields one', () => {
        const raw = {
            mystery_def: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        // No original.name — exercises the second fallback.
                        original: { argument_types: '', return_type: 'V' },
                        new: { name: 'a', argument_types: '', return_type: 'V' },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.X']!;
        expect(cls.methods!['mystery_def']).toEqual({ obfuscated: 'a', signature: '()V' });
    });
});

describe('sigmatcherRawToRosettaMap — fields', () => {
    it('passes through field name + type and assigns source=sigmatcher', () => {
        const raw = {
            Config: {
                original: { name: 'Config', package: 'com.example.testapp' },
                new: { name: 'dddd', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [
                    {
                        original: { name: 'MAX_RETRIES', type: 'I' },
                        new: { name: 'c', type: 'I' },
                    },
                    {
                        original: { name: 'ENDPOINT_URL', type: 'Ljava/lang/String;' },
                        new: { name: 'e', type: 'Ljava/lang/String;' },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.Config']!;
        expect(cls.fields).toEqual({
            MAX_RETRIES: { obfuscated: 'c', type: 'I' },
            ENDPOINT_URL: { obfuscated: 'e', type: 'Ljava/lang/String;' },
        });
    });

    it('omits the methods key when no methods matched and the fields key when no fields matched', () => {
        const raw = {
            ConfigFieldsOnly: {
                original: { name: 'ConfigFieldsOnly', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [
                    { original: { name: 'x', type: 'I' }, new: { name: 'a', type: 'I' } },
                ],
            },
            MethodsOnly: {
                original: { name: 'MethodsOnly', package: 'com.example.testapp' },
                new: { name: 'bbbb', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: { name: 'doIt', argument_types: '', return_type: 'V' },
                        new: { name: 'a', argument_types: '', return_type: 'V' },
                    },
                ],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const fieldsOnly = map.classes['com.example.testapp.ConfigFieldsOnly']!;
        const methodsOnly = map.classes['com.example.testapp.MethodsOnly']!;
        expect(fieldsOnly.methods).toBeUndefined();
        expect(fieldsOnly.fields).toBeDefined();
        expect(methodsOnly.fields).toBeUndefined();
        expect(methodsOnly.methods).toBeDefined();
    });

    it('drops field matches that are missing real-name, obf-name, or type', () => {
        const raw = {
            Partial: {
                original: { name: 'Partial', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [
                    { original: { name: 'good', type: 'I' }, new: { name: 'a', type: 'I' } },
                    { original: { type: 'I' }, new: { name: 'b', type: 'I' } }, // no real-name
                    { original: { name: 'noObf', type: 'I' }, new: { type: 'I' } }, // no obf-name
                    { original: { name: 'noType' }, new: { name: 'd' } }, // no type
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.Partial']!;
        expect(cls.fields).toEqual({ good: { obfuscated: 'a', type: 'I' } });
    });
});

describe('sigmatcherRawToRosettaMap — options propagation', () => {
    it('emits captured_at and signer_sha256 on the top-level map when provided', () => {
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, {
            ...BASE_OPTIONS,
            signerSha256: 'deadbeef'.repeat(8),
            capturedAt: '2026-05-14',
        });
        expect(map.captured_at).toBe('2026-05-14');
        expect(map.signer_sha256).toBe('deadbeef'.repeat(8));
    });

    it('emits generated_from.signatures_rev when signaturesRev is provided (#36)', () => {
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, {
            ...BASE_OPTIONS,
            signaturesRev: 'abcdef0',
        });
        expect(map.generated_from).toEqual({ signatures_rev: 'abcdef0' });
    });

    it('omits generated_from when signaturesRev is absent', () => {
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(map.generated_from).toBeUndefined();
    });

    it('applies classKindMap to set kind on emitted ClassEntry, leaves unmapped classes with kind undefined', () => {
        const raw = {
            Stub: {
                original: { name: 'IRemoteService$Stub', package: 'com.example.testapp' },
                new: { name: 'IRemoteService$Stub', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
            Plain: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, {
            ...BASE_OPTIONS,
            classKindMap: {
                'com.example.testapp.IRemoteService$Stub': 'class',
            },
        });
        expect(map.classes['com.example.testapp.IRemoteService$Stub']!.kind).toBe('class');
        expect(map.classes['com.example.testapp.BlobCache']!.kind).toBeUndefined();
    });
});

describe('sigmatcherRawToRosettaMap — canonical tool vocabulary (#32 parity)', () => {
    // The map schema keeps `tool`/`source` free-form strings, so the VALIDATOR
    // cannot forbid a framework-specific spelling. The thing actually under our
    // control is the EMITTED value: the sigmatcher adapter must only ever stamp
    // the client-NEUTRAL canonical tokens ('sigmatcher' here), NEVER a
    // framework-specific spelling like 'rosetta-frida-runtime-discovered' that
    // would diverge from what rosetta-xposed emits/accepts. This pins the
    // emitter, not the validator — the genuine enforcing guard.
    const FORBIDDEN = 'rosetta-frida-runtime-discovered';

    it("stamps the canonical 'sigmatcher' token on sources and class source, never a framework-specific one", () => {
        const raw = {
            BlobCache: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: { name: 'get', argument_types: '', return_type: 'V' },
                        new: { name: 'c', argument_types: '', return_type: 'V' },
                    },
                ],
                matched_fields: [
                    { original: { name: 'f', type: 'I' }, new: { name: 'a', type: 'I' } },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);

        // Every emitted source tool is canonical.
        for (const src of map.sources ?? []) {
            expect(src.tool).toBe('sigmatcher');
            expect(src.tool).not.toBe(FORBIDDEN);
        }
        // Every emitted class `source` is canonical.
        for (const cls of Object.values(map.classes)) {
            expect(cls.source).toBe('sigmatcher');
            expect(cls.source).not.toBe(FORBIDDEN);
        }
        // Belt-and-braces: the framework-specific token appears nowhere in the
        // serialised artifact.
        expect(JSON.stringify(map)).not.toContain(FORBIDDEN);
    });
});

describe('sigmatcherRawToRosettaMap — gracefulness', () => {
    it('skips entries whose value is not a plain object', () => {
        const raw = {
            BadString: 'not an object',
            BadArray: [1, 2, 3],
            BadNull: null,
            Good: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(Object.keys(map.classes)).toEqual(['com.example.testapp.X']);
    });

    it('skips definitions with no original package or name', () => {
        const raw = {
            NoOriginalPkg: {
                original: { name: 'Foo' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
            NoOriginalName: {
                original: { package: 'com.example.testapp' },
                new: { name: 'bbbb', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
            NoOriginalAtAll: {
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
            Good: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [],
                matched_fields: [],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(Object.keys(map.classes)).toEqual(['com.example.testapp.X']);
    });

    it('handles missing matched_methods and matched_fields arrays', () => {
        const raw = {
            BareMinimum: {
                original: { name: 'BareMinimum', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.BareMinimum']!;
        expect(cls.obfuscated).toBe('aaaa');
        expect(cls.methods).toBeUndefined();
        expect(cls.fields).toBeUndefined();
    });

    it('builds a signature even when new.argument_types / new.return_type are missing on the new side, when new has only name (defensive fallback)', () => {
        // Crafted to exercise the `?? ''` fallback branches in
        // buildJvmSignature. `new.name` is present (so the method
        // entry survives the truthy guard) but argument_types and
        // return_type are absent. We expect a "()" signature.
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: { name: 'noSigInfo' },
                        // No argument_types or return_type on the new side.
                        new: { name: 'a' },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.X']!;
        expect(cls.methods!['noSigInfo']).toEqual({ obfuscated: 'a', signature: '()' });
    });

    it('drops method matches that are missing the obfuscated new.name', () => {
        const raw = {
            PartialMethods: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: { name: 'good', argument_types: '', return_type: 'V' },
                        new: { name: 'a', argument_types: '', return_type: 'V' },
                    },
                    {
                        // No new.name → adapter must skip this one rather than throw.
                        original: { name: 'noObf', argument_types: '', return_type: 'V' },
                        new: { argument_types: '', return_type: 'V' },
                    },
                ],
            },
        };
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        const cls = map.classes['com.example.testapp.X']!;
        expect(Object.keys(cls.methods!)).toEqual(['good']);
    });

    it('drops method matches whose remerged real name is empty', () => {
        const raw = {
            EmptyKeyDef: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        // No original.name AND no fallback through methodNameMap.
                        original: { argument_types: '', return_type: 'V' },
                        new: { name: 'a', argument_types: '', return_type: 'V' },
                    },
                ],
            },
        };
        // Empty-string defName means realMethod resolves to '' → skipped.
        const map = sigmatcherRawToRosettaMap({ '': raw.EmptyKeyDef }, BASE_OPTIONS);
        // Definition was ingested (it has a class), but no method registered.
        const cls = map.classes['com.example.testapp.X']!;
        expect(cls.methods).toBeUndefined();
    });

    it('throws RosettaError if input is not a plain object', () => {
        expect(() => sigmatcherRawToRosettaMap(null, BASE_OPTIONS)).toThrow(RosettaError);
        expect(() => sigmatcherRawToRosettaMap([1, 2], BASE_OPTIONS)).toThrow(RosettaError);
        expect(() => sigmatcherRawToRosettaMap('string', BASE_OPTIONS)).toThrow(RosettaError);
    });

    it('throws RosettaError if a definition pins no obfuscated short name (no def fills new.name)', () => {
        // Class is referenced (its real FQN slot is created via a methods-only
        // definition that lacks `new.name`), but no definition ever sets the
        // class's obfuscated short name. Adapter must refuse to emit.
        const raw = {
            MethodsOnlyNoClassObf: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { package: 'com.example.testapp' }, // no name → no obf class shell
                matched_methods: [
                    {
                        original: { name: 'doIt', argument_types: '', return_type: 'V' },
                        new: { name: 'a', argument_types: '', return_type: 'V' },
                    },
                ],
            },
        };
        expect(() => sigmatcherRawToRosettaMap(raw, BASE_OPTIONS)).toThrow(RosettaError);
    });
});

describe('sigmatcherRawToRosettaMap — schema validation hook', () => {
    it('round-trips a faithful sigmatcher payload through validateMap', () => {
        // Build a non-trivial map and confirm validation passes (i.e.
        // the adapter's output shape is schema-compliant).
        const raw = {
            BlobCache: {
                original: { name: 'BlobCache', package: 'com.example.testapp' },
                new: { name: 'cccc', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: {
                            name: 'get',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                        new: {
                            name: 'c',
                            argument_types: 'Ljava/lang/String;',
                            return_type: 'Ljava/lang/Object;',
                        },
                    },
                ],
                matched_fields: [
                    {
                        original: { name: 'buffer', type: 'Ljava/util/HashMap;' },
                        new: { name: 'e', type: 'Ljava/util/HashMap;' },
                    },
                ],
            },
        };
        // Should not throw.
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(map.classes['com.example.testapp.BlobCache']!.fields!['buffer']).toEqual({
            obfuscated: 'e',
            type: 'Ljava/util/HashMap;',
        });
    });

    it('surfaces validation failures as MapValidationError (forced via empty obfuscated class name)', () => {
        // Crafted raw with a class whose `new.name` is the empty string —
        // the adapter accepts it as "first non-empty name" (i.e. it WON'T
        // set wk.obfuscated, then will throw RosettaError). To exercise
        // the validateMap branch, we use a class with `new.name` set but
        // an empty method obf-name slipping through the schema.
        //
        // The cleanest way: pass an obj that produces a method with an
        // empty `obfuscated`, which the schema rejects.
        const raw = {
            X: {
                original: { name: 'X', package: 'com.example.testapp' },
                new: { name: 'aaaa', package: 'com.example.testapp' },
                matched_methods: [
                    {
                        original: { name: 'doIt', argument_types: '', return_type: 'V' },
                        // Empty obfuscated name — schema requires min(1).
                        new: { name: '', argument_types: '', return_type: 'V' },
                    },
                ],
            },
        };
        // With name === '' the adapter skips the method (truthy check)
        // — so we directly invoke a follow-up scenario that actually
        // hits validateMap: the empty-app option.
        // Easier: produce a valid raw, but pass an invalid `app` (empty).
        const map = sigmatcherRawToRosettaMap(raw, BASE_OPTIONS);
        expect(map.classes['com.example.testapp.X']!.methods).toBeUndefined();

        expect(() => sigmatcherRawToRosettaMap(raw, { ...BASE_OPTIONS, app: '' })).toThrow(
            MapValidationError,
        );
    });
});
