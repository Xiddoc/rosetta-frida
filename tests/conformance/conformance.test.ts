/**
 * Cross-client resolver conformance runner (TypeScript side).
 *
 * Drives the REAL frida resolver / signature utilities against the same
 * provider-neutral golden fixtures the Kotlin resolver consumes
 * (`rosetta-xposed` `:core` `ConformanceTest.kt`), fulfilling RFC 0001
 * Decision 2 — "two resolver implementations, one conformance suite."
 *
 * The fixtures under `fixtures/` are VENDORED verbatim (see
 * `tests/conformance/README.md` for the source commit and the sync
 * obligation). Their schema is documented in `fixtures/README.md`; this
 * runner is implemented from that README alone.
 *
 * IMPORTANT: this runner only adapts to the *documented fixture
 * semantics*. It must never paper over a genuine TS-vs-Kotlin resolver
 * behaviour difference by massaging the resolver — such a difference is a
 * parity bug to escalate, surfaced here as a failing case.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    AmbiguousOverloadError,
    MapValidationError,
    ResolveError,
    RosettaError,
    TargetPolicyError,
    UnknownArgTypeError,
} from '../../src/errors.js';
import { createResolver, parseSignatureArgs, toJvmDescriptor } from '../../src/resolver/index.js';
import type { ResolverImpl } from '../../src/resolver/index.js';
import { pickMapForVersion } from '../../src/session/version-match.js';
import type { RosettaMapRegistry } from '../../src/types/map.js';
import {
    MAX_ANCHORS,
    MAX_APP_LEN,
    MAX_CLASSES,
    MAX_FIELDS_PER_CLASS,
    MAX_FREE_STRING_LEN,
    MAX_METHOD_OVERLOADS,
    MAX_METHODS_PER_CLASS,
    MAX_SHORT_NAME_LEN,
    MAX_SIGNATURE_LEN,
    MAX_SOURCES,
    MAX_VERSION_CODE,
    MAX_VERSION_LEN,
    validateMap,
} from '../../src/validate/schema.js';

/**
 * The frida side's copy of each shared numeric bound, keyed by the name
 * the `bounds.json` fixture uses. The conformance runner asserts each
 * fixture `value` equals the constant READ FROM THE REAL VALIDATOR — so a
 * one-sided edit to either client's constant (or the canonical schema)
 * fails this gate. Kotlin's `boundsTable` is the twin.
 */
const BOUNDS: Readonly<Record<string, number>> = {
    MAX_CLASSES,
    MAX_METHODS_PER_CLASS,
    MAX_FIELDS_PER_CLASS,
    MAX_METHOD_OVERLOADS,
    MAX_ANCHORS,
    MAX_SOURCES,
    MAX_SHORT_NAME_LEN,
    MAX_SIGNATURE_LEN,
    MAX_APP_LEN,
    MAX_VERSION_LEN,
    MAX_FREE_STRING_LEN,
    MAX_VERSION_CODE,
};

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Explicit fixture manifest — the frida twin of the Kotlin
 * `ConformanceTest.fixtures` list. An unregistered `*.json` in
 * `fixtures/` fails loudly (see the manifest-coverage guard at the
 * bottom) rather than being silently skipped. Add a filename here when
 * you vendor a new fixture.
 */
const FIXTURES: readonly string[] = [
    'basic.json',
    'classes.json',
    'methods.json',
    'overloads.json',
    'argtypes.json',
    'fields.json',
    'signatures.json',
    'type-translation.json',
    'introspection.json',
    'errors.json',
    'validation.json',
    'heuristic.json',
    'bounds.json',
    'target-policy.json',
    'version-select.json',
];

/** A single conformance case as it appears on disk (loosely typed). */
interface ConformanceCase {
    readonly name: string;
    readonly kind: string;
    readonly expectError?:
        | 'Resolve'
        | 'UnknownArgType'
        | 'AmbiguousOverload'
        | 'IllegalArgument'
        | 'MapValidation'
        | 'TargetPolicy';
    readonly inputMap?: unknown;
    readonly expectValid?: boolean;
    readonly class?: string;
    readonly method?: string;
    readonly field?: string;
    readonly argTypes?: readonly string[];
    readonly type?: string;
    readonly obf?: string;
    readonly signature?: string;
    readonly expectObf?: string;
    readonly expectSignature?: string;
    readonly expectClassName?: string;
    readonly expectStatic?: boolean;
    readonly expectAidlTxn?: number;
    readonly expectOverloadCount?: number;
    readonly expectType?: string;
    readonly expectExtends?: string | null;
    readonly expectResult?: string | boolean | null;
    readonly expectList?: readonly string[];
    // `bound` cases (bounds.json): a named shared constant and its value.
    readonly bound?: string;
    readonly value?: number;
    // `fuzzySelect` cases (version-select.json): registry-selection parity.
    readonly versions?: readonly string[];
    readonly target?: string;
    readonly expectSelected?: string;
    // `codeSelect` cases (version-select.json): exact version_code selection.
    readonly versionCodes?: readonly number[];
    readonly targetCode?: number;
    readonly expectSelectedCode?: number;
    // `codeCollision` cases (version-select.json): FIRST-WINS duplicate-code policy.
    readonly maps?: readonly { readonly versionCode: number; readonly version: string }[];
    readonly expectSelectedVersion?: string;
    // Error cases (errors.json): a byte-identical substring (sans the
    // per-client brand prefix) the thrown error message must contain.
    readonly expectMessageIncludes?: string;
}

interface ConformanceFixture {
    readonly map?: unknown;
    readonly cases: readonly ConformanceCase[];
}

/** Load + parse + (when present) validate a fixture and build its resolver. */
function loadFixture(file: string): { fixture: ConformanceFixture; resolver: ResolverImpl | null } {
    const fixture = JSON.parse(
        readFileSync(join(FIXTURES_DIR, file), 'utf8'),
    ) as ConformanceFixture;
    // `map` is optional: pure-utility fixtures need none. When present it is
    // validated through the real schema (the frida twin of Kotlin's
    // MapLoader.validate) before a single shared resolver is built from it.
    // `createResolver` returns the public `Resolver` interface; the
    // concrete `ResolverImpl` additionally exposes `hasClass` /
    // `reverseLookup` (the introspection cases), so we keep the concrete
    // type here.
    const resolver =
        fixture.map === undefined
            ? null
            : (createResolver(validateMap(fixture.map)) as ResolverImpl);
    return { fixture, resolver };
}

/** Require a resolver for a map-touching case. */
function need(resolver: ResolverImpl | null): ResolverImpl {
    if (resolver === null) {
        throw new Error('case kind requires a "map" in the fixture');
    }
    return resolver;
}

/**
 * Exercise the resolver / utility for a case and return its raw result.
 * Used both for success cases and (its throwing) for error cases.
 */
function invoke(resolver: ResolverImpl | null, c: ConformanceCase): unknown {
    switch (c.kind) {
        case 'class':
            return need(resolver).resolveClass(c.class as string);
        case 'method':
            return need(resolver).resolveMethod(c.class as string, c.method as string, c.argTypes);
        case 'field':
            return need(resolver).resolveField(c.class as string, c.field as string);
        case 'hasClass':
            return need(resolver).hasClass(c.class as string);
        case 'reverseLookup':
            return need(resolver).reverseLookup(c.obf as string);
        case 'translateType':
            return need(resolver).translateType(c.type as string);
        case 'toJvmDescriptor':
            return toJvmDescriptor(c.type as string, (n) => need(resolver).translateType(n));
        case 'parseSignatureArgs':
            return parseSignatureArgs(c.signature as string);
        default:
            throw new Error(`unknown case kind '${c.kind}'`);
    }
}

/** Assert the documented success expectations for a resolved case. */
function assertSuccess(resolver: ResolverImpl | null, c: ConformanceCase): void {
    const result = invoke(resolver, c) as Record<string, unknown>;
    switch (c.kind) {
        case 'class':
            expect(result.obfName).toBe(c.expectObf);
            if ('expectExtends' in c) {
                expect((result.entry as Record<string, unknown>).extends ?? null).toBe(
                    c.expectExtends ?? null,
                );
            }
            return;
        case 'method':
            expect(result.obfName).toBe(c.expectObf);
            if ('expectSignature' in c) expect(result.signature).toBe(c.expectSignature);
            // expectClassName is the obfuscated SHORT name of the owning class,
            // verbatim from the class entry's `obfuscated` token (NOT an FQN).
            if ('expectClassName' in c) expect(result.className).toBe(c.expectClassName);
            if ('expectStatic' in c) expect(result.static).toBe(c.expectStatic);
            if ('expectAidlTxn' in c) expect(result.aidlTxn).toBe(c.expectAidlTxn);
            if ('expectOverloadCount' in c) {
                expect((result.allOverloads as unknown[]).length).toBe(c.expectOverloadCount);
            }
            return;
        case 'field':
            expect(result.obfName).toBe(c.expectObf);
            if ('expectStatic' in c) expect(result.static).toBe(c.expectStatic);
            if ('expectType' in c) expect(result.type).toBe(c.expectType);
            if ('expectClassName' in c) expect(result.className).toBe(c.expectClassName);
            return;
        default:
            // hasClass / reverseLookup / translateType / toJvmDescriptor /
            // parseSignatureArgs all assert the single generic expectation.
            if ('expectList' in c) {
                expect(result).toEqual(c.expectList);
                return;
            }
            // reverseLookup miss returns undefined; the fixture asserts JSON
            // null — normalize undefined to null before comparing.
            expect(result ?? null).toEqual(c.expectResult ?? null);
            return;
    }
}

/**
 * Assert that running the case throws the frida error mapped from the
 * fixture's taxonomy:
 *   Resolve           -> ResolveError
 *   AmbiguousOverload -> AmbiguousOverloadError
 *   IllegalArgument   -> a plain thrown Error/RangeError from a signature
 *                        helper (i.e. NOT one of the structured RosettaErrors)
 */
function assertError(resolver: ResolverImpl | null, c: ConformanceCase): void {
    let thrown: unknown;
    expect(() => {
        try {
            invoke(resolver, c);
        } catch (e) {
            thrown = e;
            throw e;
        }
    }).toThrow();
    switch (c.expectError) {
        case 'UnknownArgType':
            // The DISTINCT precise subtype. Asserted before 'Resolve' so a
            // generic ResolveError can't satisfy an UnknownArgType case (it
            // is a ResolveError subtype).
            expect(thrown).toBeInstanceOf(UnknownArgTypeError);
            break;
        case 'Resolve':
            // A generic Resolve case must NOT be the precise subtype, so a
            // resolver that wrongly raised UnknownArgType here is caught.
            expect(thrown).toBeInstanceOf(ResolveError);
            expect(thrown).not.toBeInstanceOf(UnknownArgTypeError);
            break;
        case 'AmbiguousOverload':
            expect(thrown).toBeInstanceOf(AmbiguousOverloadError);
            break;
        case 'IllegalArgument':
            expect(thrown).toBeInstanceOf(Error);
            expect(thrown).not.toBeInstanceOf(RosettaError);
            break;
        case 'MapValidation':
            expect(thrown).toBeInstanceOf(MapValidationError);
            break;
        case 'TargetPolicy':
            // The target-namespace guard (target-policy.json / xposed#11):
            // a forbidden obfuscated target is rejected at the resolver
            // chokepoint before any Java.use. Kotlin twin: TargetPolicyException.
            expect(thrown).toBeInstanceOf(TargetPolicyError);
            break;
        /* c8 ignore next 2 -- unreachable: fixture taxonomy is closed */
        default:
            throw new Error(`unknown expectError '${String(c.expectError)}'`);
    }
    // Canonical-wording parity: when the fixture pins `expectMessageIncludes`,
    // the thrown message must CONTAIN that byte-identical substring. The
    // substring deliberately excludes the per-client brand prefix
    // (`rosetta-frida:` here, `rosetta-xposed:` on the twin), which differs by
    // design; everything after the prefix is identical across clients.
    if (c.expectMessageIncludes !== undefined) {
        expect((thrown as Error).message).toContain(c.expectMessageIncludes);
    }
}

/**
 * Run a `bound`-kind case (bounds.json): assert the fixture's `value`
 * equals the shared numeric constant read from the REAL frida validator
 * (looked up in {@link BOUNDS}). Any drift between the canonical schema,
 * the Zod validator, and the Kotlin BoundsChecker fails on both sides.
 */
function runBoundCase(c: ConformanceCase): void {
    const name = c.bound as string;
    expect(name in BOUNDS, `unknown bound '${name}'`).toBe(true);
    expect(BOUNDS[name]).toBe(c.value);
}

/**
 * Run a `fuzzySelect`-kind case (version-select.json / xposed#13): build a
 * registry from the case's `versions` (each backed by a throwaway map whose
 * `version` label IS the key) and assert the opt-in fuzzy selector picks
 * `expectSelected`. The Kotlin twin runs `VersionMatch.select` with
 * `allowFuzzyMatch = true`; here it is `pickMapForVersion` with
 * `versionMatch: 'fuzzy'`.
 */
function runFuzzySelectCase(c: ConformanceCase): void {
    const versions = c.versions as readonly string[];
    const registry: RosettaMapRegistry = {};
    versions.forEach((label, i) => {
        // version_code must be unique per entry so the registry's authoritative
        // index never collapses two labels; the codes are otherwise irrelevant
        // (fuzzy selection ranks on the version LABEL, not the code).
        registry[label] = {
            schema_version: 2,
            app: 'com.example.app',
            version: label,
            version_code: i + 1,
            classes: {},
        };
    });
    const picked = pickMapForVersion(registry, {
        version: c.target as string,
        versionMatch: 'fuzzy',
    });
    expect(picked.fuzzy).toBe(true);
    expect(picked.registryKey).toBe(c.expectSelected);
}

/**
 * Run a `codeSelect`-kind case (version-select.json): build a registry from the
 * case's `versionCodes` (each backed by a throwaway map whose `version` label is
 * the code as a string) and assert that exact selection by `targetCode` returns
 * the map with `expectSelectedCode`. Pins that a WIDE version_code (> 2^31, the
 * Android `versionCodeMajor` regime) selects exactly with no 32-bit truncation.
 * The Kotlin twin runs `VersionMatch.select` with that `versionCode`; here it is
 * `pickMapForVersion` with `versionCode` (the authoritative O(1) path).
 */
function runCodeSelectCase(c: ConformanceCase): void {
    const codes = c.versionCodes as readonly number[];
    const registry: RosettaMapRegistry = {};
    codes.forEach((code) => {
        registry[String(code)] = {
            schema_version: 2,
            app: 'com.example.app',
            version: String(code),
            version_code: code,
            classes: {},
        };
    });
    const picked = pickMapForVersion(registry, {
        version: 'no-such-label',
        versionCode: c.targetCode,
    });
    expect(picked.fuzzy).toBe(false);
    // Pin the exact selection tier (not just `fuzzy === false`) to match the
    // Kotlin twin's `MatchedBy.VERSION_CODE` assertion: an exact version_code
    // pick is `fuzzyKind: 'exact'`. (No `'version_code'`-specific kind is
    // exposed; `'exact'` is the closest distinct tier and rules out the label /
    // range / nearest paths.)
    expect(picked.fuzzyKind).toBe('exact');
    expect(picked.map.version_code).toBe(c.expectSelectedCode);
}

/**
 * Run a `codeCollision`-kind case (version-select.json): build a registry from
 * the case's `maps` (each `{versionCode, version}`, IN INPUT ORDER, keyed by its
 * `version` label so two maps sharing a `version_code` both register) and assert
 * that exact selection by `targetCode` returns the FIRST map that claimed the
 * code. Pins the cross-client canonical FIRST-WINS collision policy (the
 * memoised `versionCodeIndex` putIfAbsent); the Kotlin twin runs
 * `MapRegistry.fromCollection` (putIfAbsent) + `VersionMatch.select`.
 */
function runCodeCollisionCase(c: ConformanceCase): void {
    const entries = c.maps as readonly { versionCode: number; version: string }[];
    const registry: RosettaMapRegistry = {};
    // Object literal insertion order is preserved for these non-integer string
    // keys, so Object.keys() iterates in input order and putIfAbsent picks the
    // FIRST map for the shared code — exactly what the policy asserts.
    entries.forEach((e) => {
        registry[e.version] = {
            schema_version: 2,
            app: 'com.example.app',
            version: e.version,
            version_code: e.versionCode,
            classes: {},
        };
    });
    const picked = pickMapForVersion(registry, {
        version: 'no-such-label',
        versionCode: c.targetCode,
    });
    expect(picked.fuzzy).toBe(false);
    expect(picked.fuzzyKind).toBe('exact');
    expect(picked.map.version).toBe(c.expectSelectedVersion);
}

/**
 * Run a `validate`-kind case: validate the case's own inline `inputMap`
 * through the real schema and assert it is accepted (`expectValid: true`)
 * or rejected (`expectError: 'MapValidation'`). This is how the oracle
 * covers VALIDATION semantics (e.g. the `minLength: 1` non-empty
 * `obfuscated` rule) on top of resolution semantics — the Kotlin twin runs
 * the same `inputMap` through `MapLoader.validate`.
 */
function runValidateCase(c: ConformanceCase): void {
    // A malformed fixture that sets neither expectation would otherwise fall
    // through to `expect(undefined).toBe(true)` (a cryptic "expected undefined
    // to be true"). Fail with a field-naming diagnostic instead, mirroring the
    // Kotlin runner's "validate success case must set expectValid: true".
    /* c8 ignore next 5 -- defensive guard: every vendored validate case is
       well-formed, so this never fires; it exists to give a field-naming
       diagnostic if a future fixture is malformed. */
    if (c.expectError === undefined && c.expectValid !== true) {
        throw new Error(
            `validate case '${c.name}' must set either expectError: 'MapValidation' or expectValid: true`,
        );
    }
    if (c.expectError !== undefined) {
        expect(c.expectError).toBe('MapValidation');
        expect(() => validateMap(c.inputMap)).toThrow(MapValidationError);
        return;
    }
    expect(c.expectValid).toBe(true);
    // Throws on failure → the case fails, which is the assertion.
    validateMap(c.inputMap);
}

for (const file of FIXTURES) {
    const { fixture, resolver } = loadFixture(file);
    describe(`conformance :: ${file}`, () => {
        for (const c of fixture.cases) {
            it(c.name, () => {
                if (c.kind === 'validate') {
                    runValidateCase(c);
                } else if (c.kind === 'bound') {
                    runBoundCase(c);
                } else if (c.kind === 'fuzzySelect') {
                    runFuzzySelectCase(c);
                } else if (c.kind === 'codeSelect') {
                    runCodeSelectCase(c);
                } else if (c.kind === 'codeCollision') {
                    runCodeCollisionCase(c);
                } else if (c.expectError !== undefined) {
                    assertError(resolver, c);
                } else {
                    assertSuccess(resolver, c);
                }
            });
        }
    });
}

describe('conformance manifest', () => {
    it('covers every vendored fixture (no silent skips)', () => {
        const onDisk = readdirSync(FIXTURES_DIR)
            .filter((f) => f.endsWith('.json'))
            .sort();
        expect([...FIXTURES].sort()).toEqual(onDisk);
    });
});
