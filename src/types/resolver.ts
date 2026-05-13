/**
 * Resolver — the core real → obf translation abstraction.
 *
 * LOCKED contract. Wave 1B implements this; Waves 2E/F/G consume it.
 */

import type { ClassEntry, MethodEntry, FieldEntry } from './map.js';

/** Result of resolving a class. */
export interface ResolvedClass {
    /** Real fully-qualified name. */
    realName: string;
    /** Obfuscated short name. */
    obfName: string;
    /** Full class entry from the map, for downstream consumers. */
    entry: ClassEntry;
}

/** Result of resolving a method on a class. */
export interface ResolvedMethod {
    /** Real method name. */
    realName: string;
    /** Obfuscated method name. */
    obfName: string;
    /**
     * The obfuscated short class name this method lives on.
     * Useful for tier-3 callers doing raw Java.use.
     */
    className: string;
    /** Method signature in JVM descriptor form (obfuscated class refs). */
    signature: string;
    /** Optional AIDL transaction code. */
    aidlTxn?: number;
    /** Static flag. */
    static: boolean;
    /** All overloads when the real name had multiple — selected one is at [0]. */
    allOverloads: MethodEntry[];
}

/** Result of resolving a field on a class. */
export interface ResolvedField {
    /** Real field name. */
    realName: string;
    /** Obfuscated field name. */
    obfName: string;
    /** The obfuscated short class name this field lives on. */
    className: string;
    /** Field type in JVM descriptor form. */
    type: string;
    /** Static flag. */
    static: boolean;
}

/**
 * The Resolver. Stateful per-session.
 *
 * Lookup chain:
 *   1. Memoized cache (per session)
 *   2. Mapping lookup
 *   3. Throw ResolveError (V1) — V2+ runs discovery strategies here
 */
export interface Resolver {
    /** Resolve a class by real name. */
    resolveClass(realName: string): ResolvedClass;

    /**
     * Resolve a method by real names. If multiple overloads exist for
     * the given method name, `argTypes` (real names + framework types)
     * is used to disambiguate. If `argTypes` is omitted and there's
     * exactly one overload, that one is returned; ambiguity throws.
     */
    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod;

    /** Resolve a field by real names. */
    resolveField(className: string, fieldName: string): ResolvedField;

    /**
     * Translate a single type name. Real-name in map → obf out;
     * primitive or unmapped framework type → passthrough.
     * Used by overload-argument translation and signature rewriting.
     */
    translateType(typeName: string): string;

    /** Forcibly invalidate a cached resolution. */
    invalidate(realName: string): void;

    /**
     * Install a runtime override for a class entry. Future lookups
     * see this instead of the map's value. Useful for tier-3 escape
     * hatches and tests.
     */
    override(realName: string, entry: ClassEntry): void;

    /** Look up the FieldEntry on a class without resolving it. */
    lookupField(className: string, fieldName: string): FieldEntry | undefined;
}
