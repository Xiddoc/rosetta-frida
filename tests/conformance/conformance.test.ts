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
    UnknownArgTypeError,
} from '../../src/errors.js';
import { createResolver, parseSignatureArgs, toJvmDescriptor } from '../../src/resolver/index.js';
import type { ResolverImpl } from '../../src/resolver/index.js';
import { validateMap } from '../../src/validate/schema.js';

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
        | 'MapValidation';
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
            return;
        case 'Resolve':
            // A generic Resolve case must NOT be the precise subtype, so a
            // resolver that wrongly raised UnknownArgType here is caught.
            expect(thrown).toBeInstanceOf(ResolveError);
            expect(thrown).not.toBeInstanceOf(UnknownArgTypeError);
            return;
        case 'AmbiguousOverload':
            expect(thrown).toBeInstanceOf(AmbiguousOverloadError);
            return;
        case 'IllegalArgument':
            expect(thrown).toBeInstanceOf(Error);
            expect(thrown).not.toBeInstanceOf(RosettaError);
            return;
        case 'MapValidation':
            expect(thrown).toBeInstanceOf(MapValidationError);
            return;
        /* c8 ignore next 2 -- unreachable: fixture taxonomy is closed */
        default:
            throw new Error(`unknown expectError '${String(c.expectError)}'`);
    }
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
