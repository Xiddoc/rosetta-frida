/**
 * Concrete Resolver implementation.
 *
 * Lookup chain per design §3.1:
 *   1. Memoized cache (per session)
 *   2. Mapping lookup (overrides take precedence over the loaded map)
 *   3. Throw ResolveError (V1 — V2+ runs discovery strategies here)
 *
 * The Resolver is the only place that knows about real ↔ obf translation.
 * It maintains a reverse index obfClass → realClass built at construction
 * so `translateType(...)` can be used both ways (the on-disk signature
 * uses obf class refs; we don't currently need obf → real direction but
 * the reverse index is cheap and ready for tier-3 introspection).
 */

import { AmbiguousOverloadError, ResolveError, UnknownArgTypeError } from '../errors.js';
import type { EventBus } from '../diagnostics/event-bus.js';
import type { ClassEntry, FieldEntry, MethodEntry, RosettaMap } from '../types/map.js';
import type { ResolvedClass, ResolvedField, ResolvedMethod, Resolver } from '../types/resolver.js';
import type { FailurePolicy, TargetPolicy } from '../types/session.js';
import { makeSentinel } from './sentinel.js';
import { parseSignatureArgs, toJvmDescriptor } from './signature.js';
import { appPrefixOf, assertTargetAllowed } from './target-policy.js';

/** Options for constructing a Resolver directly. */
export interface ResolverOptions {
    /** The loaded map. */
    map: RosettaMap;
    /** Where to emit resolution events. Required — diagnostics is core. */
    events: EventBus;
    /**
     * Failure policy. Default 'strict' (throw on miss). Stored on the
     * resolver and exposed via {@link Resolver.failurePolicy}; the tier-1/2
     * factories (`makeClassProxy` / `hook` / `field`) dispatch through the
     * sentinel-aware wrappers (`resolve*OrSentinel`) using it, so 'warn'
     * emits a miss event + returns a sentinel that throws only on use.
     * Plain `resolveClass/Method/Field` always throw, regardless of policy
     * — the sentinel decision happens one level up.
     */
    failurePolicy?: FailurePolicy;
    /**
     * Target-namespace guard policy (RFC 0001 C1). Confines the FQNs a map
     * can redirect hooks at. Omitted → built-in `DEFAULT_DENY_PREFIXES`,
     * empty allowlist, 2 app-namespace labels — fail-closed.
     */
    targetPolicy?: TargetPolicy;
    /**
     * The app package name used to derive the app's own namespace prefix
     * for the guard. Defaults to `map.app` when omitted.
     */
    appPackage?: string;
}

interface CachedClass {
    source: 'cache' | 'map' | 'override';
    value: ResolvedClass;
}

interface CachedMember<T> {
    source: 'cache' | 'map' | 'override';
    value: T;
}

/**
 * Cache key for method resolutions, including arg-types disambiguator.
 * Methods cached without argTypes use a fixed sentinel key so a
 * subsequent argTypes-bearing lookup re-resolves.
 */
function methodCacheKey(
    className: string,
    methodName: string,
    argTypes?: readonly string[],
): string {
    const args = argTypes ? `|${argTypes.join(',')}` : '|<auto>';
    return `${className}#${methodName}${args}`;
}

/** Cache key for fields. */
function fieldCacheKey(className: string, fieldName: string): string {
    return `${className}.${fieldName}`;
}

/** Well-known Java primitive type NAMES (the `int`/`boolean`/… vocabulary). */
const PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set([
    'void',
    'boolean',
    'byte',
    'char',
    'short',
    'int',
    'long',
    'float',
    'double',
]);

/**
 * Decide whether an overload-disambiguation arg type that failed to match is
 * an UNMAPPED CLASS NAME (→ {@link UnknownArgTypeError}) versus a legitimate
 * no-overload-matches miss (→ generic {@link ResolveError}).
 *
 * KEEP IN SYNC — this function is DUPLICATED by value in two languages:
 * rosetta-frida (TS, here) and rosetta-xposed
 * (`core/.../resolver/Resolver.kt`, the Kotlin twin). The duplication is
 * intentional (each client stays pure-TS / pure-JVM with no shared runtime),
 * so the two copies MUST make the same distinction or the clients raise
 * different errors for the same input. The shared conformance fixtures
 * (`errors.json`, `methods.json`, `overloads.json`) PIN the boundary cases.
 * Changing the heuristic here requires: (a) making the same change in the
 * Kotlin twin, (b) verifying the conformance fixtures still cover the new
 * boundary, and (c) adding a fixture case (byte-identical in both repos, with
 * both sha256 manifests regenerated) if they do not.
 *
 * Returns the first offending arg type, or `null` when every arg is either a
 * known class, a primitive/array/raw descriptor, or a descriptor some
 * overload actually declares.
 *
 * HEURISTIC — `isClassNameForm` decides "this arg type is a dotted class name
 * the caller expected the map to know," as opposed to a raw descriptor /
 * primitive / array passed verbatim. It does so by EXCLUSION (a class name
 * has no positive marker — `com.example.Foo`, `IFoo`, and a bare `Foo` are
 * all valid), matching the Kotlin exclusions one-for-one:
 *   - `L…` raw object descriptor / `[…` raw array descriptor;
 *   - `…[]` source-style array;
 *   - a named primitive (`int`, `boolean`, …);
 *   - a single character (a lone descriptor letter `I`/`Z`/`L`/…) — safe
 *     because no real Java type name is one character long.
 */
function unknownArgTypeOrNull(
    argTypes: readonly string[],
    wanted: readonly string[],
    overloads: readonly MethodEntry[],
    knownClass: (name: string) => boolean,
): string | null {
    const knownDescriptors = new Set<string>();
    for (const overload of overloads) {
        for (const arg of parseSignatureArgs(overload.signature)) {
            knownDescriptors.add(arg);
        }
    }
    for (let i = 0; i < argTypes.length; i += 1) {
        const argType = argTypes[i] as string;
        const isClassNameForm =
            !argType.startsWith('L') &&
            !argType.startsWith('[') &&
            !argType.endsWith('[]') &&
            !PRIMITIVE_TYPE_NAMES.has(argType) &&
            // Exclude a lone descriptor letter (I/Z/L/…); no real type name
            // is one character, so this never drops a legitimate class name.
            argType.length !== 1;
        if (isClassNameForm && !knownClass(argType) && !knownDescriptors.has(wanted[i] as string)) {
            return argType;
        }
    }
    return null;
}

export class ResolverImpl implements Resolver {
    /** Effective failure policy (see {@link Resolver.failurePolicy}). */
    readonly failurePolicy: FailurePolicy;

    readonly #map: RosettaMap;
    readonly #events: EventBus;

    /** Runtime overrides — take precedence over `#map.classes`. */
    readonly #overrides = new Map<string, ClassEntry>();

    /** Cached class resolutions. */
    readonly #classCache = new Map<string, CachedClass>();

    /** Cached method resolutions. */
    readonly #methodCache = new Map<string, CachedMember<ResolvedMethod>>();

    /** Cached field resolutions. */
    readonly #fieldCache = new Map<string, CachedMember<ResolvedField>>();

    /** Reverse index: obfuscated class short name → real FQN. */
    readonly #reverseClassIndex = new Map<string, string>();

    /** Target-namespace guard policy (RFC 0001 C1). */
    readonly #targetPolicy: TargetPolicy;

    /** The app's own namespace prefix, derived once from the app package. */
    readonly #appPrefix: string;

    /**
     * Cache epoch — bumped on every cache invalidation (which `override`
     * triggers). Lets long-lived consumers with their own caches (proxies)
     * detect staleness. See {@link cacheEpoch}.
     */
    #epoch = 0;

    constructor(options: ResolverOptions) {
        this.failurePolicy = options.failurePolicy ?? 'strict';
        this.#map = options.map;
        this.#events = options.events;
        this.#targetPolicy = options.targetPolicy ?? {};
        this.#appPrefix = appPrefixOf(options.appPackage ?? this.#map.app, this.#targetPolicy);
        for (const [realName, entry] of Object.entries(this.#map.classes)) {
            // putIfAbsent: when two real classes share an obfuscated short
            // name (which shouldn't happen in a well-formed map) the FIRST
            // one in iteration order keeps the reverse mapping. This
            // FIRST-WINS rule is the CROSS-CLIENT CANONICAL collision policy:
            // the Kotlin rosetta-xposed resolver builds its reverse index the
            // same way (`reverseClassIndex.putIfAbsent(...)`), so a
            // collision-laden map reverse-resolves to the same real name on
            // both clients. Do not flip this to last-wins without changing the
            // Kotlin twin in lockstep. (A deliberate `override(...)` later DOES
            // re-point the obf → real entry — that is a separate write path.)
            if (!this.#reverseClassIndex.has(entry.obfuscated)) {
                this.#reverseClassIndex.set(entry.obfuscated, realName);
            }
        }
    }

    /** True if `realName` is a known class real-name (override or map). */
    hasClass(realName: string): boolean {
        return (
            this.#overrides.has(realName) ||
            Object.prototype.hasOwnProperty.call(this.#map.classes, realName)
        );
    }

    resolveClass(realName: string): ResolvedClass {
        const cached = this.#classCache.get(realName);
        if (cached !== undefined) {
            this.#emitResolve({
                name: realName,
                obfName: cached.value.obfName,
                source: 'cache',
            });
            return cached.value;
        }

        const override = this.#overrides.get(realName);
        if (override !== undefined) {
            // Guard BEFORE caching — a denied target must never be cached
            // (no cache poisoning) and must throw before any Java.use call.
            assertTargetAllowed(realName, override.obfuscated, this.#appPrefix, this.#targetPolicy);
            const value: ResolvedClass = {
                realName,
                obfName: override.obfuscated,
                entry: override,
            };
            this.#classCache.set(realName, { source: 'override', value });
            this.#emitResolve({ name: realName, obfName: value.obfName, source: 'override' });
            return value;
        }

        const entry = this.#map.classes[realName];
        if (entry === undefined) {
            this.#emitResolve({ name: realName, source: 'map', miss: true });
            throw new ResolveError(
                this.#missMessage('class', realName),
                realName,
                this.#map.app,
                this.#map.version,
                'class',
            );
        }
        // Guard BEFORE caching — see the override branch above.
        assertTargetAllowed(realName, entry.obfuscated, this.#appPrefix, this.#targetPolicy);
        const value: ResolvedClass = { realName, obfName: entry.obfuscated, entry };
        this.#classCache.set(realName, { source: 'map', value });
        this.#emitResolve({ name: realName, obfName: value.obfName, source: 'map' });
        return value;
    }

    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod {
        const key = methodCacheKey(className, methodName, argTypes);
        const cached = this.#methodCache.get(key);
        if (cached !== undefined) {
            this.#emitResolve({
                name: methodName,
                obfName: cached.value.obfName,
                source: 'cache',
                classScope: className,
                overloadSignature: cached.value.signature,
            });
            return cached.value;
        }

        // Resolving the parent class also caches it; that's intentional.
        const cls = this.resolveClass(className);
        const methods = cls.entry.methods;
        const raw = methods?.[methodName];
        if (raw === undefined) {
            this.#emitResolve({
                name: methodName,
                source: 'map',
                miss: true,
                classScope: className,
            });
            throw new ResolveError(
                this.#missMessage('method', methodName, className),
                methodName,
                this.#map.app,
                this.#map.version,
                'method',
                className,
            );
        }

        // `raw` is always a (non-empty) MethodEntry[] post-validation — the
        // schema normalises the single-overload authoring form to an array.
        const overloads: MethodEntry[] = raw;

        let picked: MethodEntry;
        if (argTypes === undefined) {
            if (overloads.length === 1) {
                picked = overloads[0] as MethodEntry;
            } else {
                throw new AmbiguousOverloadError(
                    `rosetta-frida: method '${className}.${methodName}' has ${overloads.length} overloads — pass argTypes to disambiguate.`,
                    methodName,
                    className,
                    overloads.length,
                );
            }
        } else {
            const wanted = argTypes.map((t) => toJvmDescriptor(t, (n) => this.translateType(n)));
            const match = overloads.find((overload) => {
                const have = parseSignatureArgs(overload.signature);
                if (have.length !== wanted.length) {
                    return false;
                }
                for (let i = 0; i < have.length; i += 1) {
                    if (have[i] !== wanted[i]) {
                        return false;
                    }
                }
                return true;
            });
            if (match === undefined) {
                this.#emitResolve({
                    name: methodName,
                    source: 'map',
                    miss: true,
                    classScope: className,
                });
                // Prefer the precise unknown-arg-type error when an arg type is
                // an unmapped class the overloads don't even declare; otherwise
                // the generic no-overload-matches error. Mirrors the Kotlin
                // `overloadMissException` split so both clients agree.
                const unknownArg = unknownArgTypeOrNull(argTypes, wanted, overloads, (n) =>
                    this.hasClass(n),
                );
                if (unknownArg !== null) {
                    throw new UnknownArgTypeError(
                        `rosetta-frida: arg type '${unknownArg}' (for '${className}.${methodName}') is not a known class in the map for ${this.#map.app}@${this.#map.version}; no overload declares it either. Map the class or pass a type the map knows.`,
                        methodName,
                        this.#map.app,
                        this.#map.version,
                        className,
                        unknownArg,
                    );
                }
                throw new ResolveError(
                    `rosetta-frida: no overload of '${className}.${methodName}' matches arg types [${argTypes.join(', ')}] in map for ${this.#map.app}@${this.#map.version}.`,
                    methodName,
                    this.#map.app,
                    this.#map.version,
                    'method',
                    className,
                );
            }
            picked = match;
        }

        const value: ResolvedMethod = {
            realName: methodName,
            obfName: picked.obfuscated,
            className: cls.obfName,
            signature: picked.signature,
            aidlTxn: picked.aidl_txn,
            static: picked.static === true,
            // Selected entry first so consumers can do allOverloads[0] safely.
            allOverloads: [picked, ...overloads.filter((o) => o !== picked)],
        };
        this.#methodCache.set(key, { source: 'map', value });
        this.#emitResolve({
            name: methodName,
            obfName: value.obfName,
            source: 'map',
            classScope: className,
            overloadSignature: value.signature,
        });
        return value;
    }

    resolveField(className: string, fieldName: string): ResolvedField {
        const key = fieldCacheKey(className, fieldName);
        const cached = this.#fieldCache.get(key);
        if (cached !== undefined) {
            this.#emitResolve({
                name: fieldName,
                obfName: cached.value.obfName,
                source: 'cache',
                classScope: className,
            });
            return cached.value;
        }

        const cls = this.resolveClass(className);
        const entry = cls.entry.fields?.[fieldName];
        if (entry === undefined) {
            this.#emitResolve({
                name: fieldName,
                source: 'map',
                miss: true,
                classScope: className,
            });
            throw new ResolveError(
                this.#missMessage('field', fieldName, className),
                fieldName,
                this.#map.app,
                this.#map.version,
                'field',
                className,
            );
        }
        const value: ResolvedField = {
            realName: fieldName,
            obfName: entry.obfuscated,
            className: cls.obfName,
            type: entry.type,
            static: entry.static === true,
        };
        this.#fieldCache.set(key, { source: 'map', value });
        this.#emitResolve({
            name: fieldName,
            obfName: value.obfName,
            source: 'map',
            classScope: className,
        });
        return value;
    }

    translateType(typeName: string): string {
        // Secondary vector (decision #4): the arg-type → obf descriptor path
        // also produces a map-controlled FQN that flows into Java.use via
        // .overload(...). Guard the MAPPED-output branches through the same
        // predicate; the unmapped passthrough is the caller's own input, not
        // a map-controlled target, so it is left untouched.
        const override = this.#overrides.get(typeName);
        if (override !== undefined) {
            assertTargetAllowed(typeName, override.obfuscated, this.#appPrefix, this.#targetPolicy);
            return override.obfuscated;
        }
        const entry = this.#map.classes[typeName];
        if (entry !== undefined) {
            assertTargetAllowed(typeName, entry.obfuscated, this.#appPrefix, this.#targetPolicy);
            return entry.obfuscated;
        }
        return typeName;
    }

    invalidate(realName: string): void {
        this.#classCache.delete(realName);
        // Drop method/field cache entries scoped to this class.
        for (const key of Array.from(this.#methodCache.keys())) {
            if (key.startsWith(`${realName}#`)) {
                this.#methodCache.delete(key);
            }
        }
        for (const key of Array.from(this.#fieldCache.keys())) {
            if (key.startsWith(`${realName}.`)) {
                this.#fieldCache.delete(key);
            }
        }
        // Signal long-lived consumers (proxies) that their own caches may
        // now be stale, so a subsequent override is reflected in live
        // tier-2 proxies built before the override landed.
        this.#epoch += 1;
    }

    cacheEpoch(): number {
        return this.#epoch;
    }

    override(realName: string, entry: ClassEntry): void {
        this.#overrides.set(realName, entry);
        this.#reverseClassIndex.set(entry.obfuscated, realName);
        // Invalidating here is critical: a stale cache would mask the override.
        this.invalidate(realName);
    }

    lookupField(className: string, fieldName: string): FieldEntry | undefined {
        const override = this.#overrides.get(className);
        const cls = override ?? this.#map.classes[className];
        return cls?.fields?.[fieldName];
    }

    /**
     * Reverse-lookup an obfuscated class short name to its real FQN.
     * Returns undefined if no mapping exists. Part of the locked
     * {@link Resolver} contract; the index reflects runtime overrides.
     */
    reverseLookup(obfName: string): string | undefined {
        return this.#reverseClassIndex.get(obfName);
    }

    #emitResolve(payload: {
        name: string;
        obfName?: string;
        source: 'cache' | 'map' | 'override';
        miss?: boolean;
        classScope?: string;
        overloadSignature?: string;
    }): void {
        this.#events.emit({ type: 'resolve', ...payload });
    }

    /**
     * Canonical cross-client miss wording (RFC 0001 / maps decision): a class
     * miss reads `class '<name>' not found`; a method or field miss reads
     * `method '<name>' not found on class '<class>'` (the member's OWN name,
     * scoped by the class it was looked up on — NOT a dotted `class.member`
     * blob). The `in map for <app>@<version>` suffix is retained so a failure
     * still names the map it was resolved against. The rosetta-xposed Kotlin
     * twin must use the identical wording; the conformance suite (which today
     * pins error TYPES, not strings) gains a string case when this lands.
     */
    #missMessage(kind: 'class', name: string): string;
    #missMessage(kind: 'method' | 'field', name: string, className: string): string;
    #missMessage(kind: 'class' | 'method' | 'field', name: string, className?: string): string {
        const where = `in map for ${this.#map.app}@${this.#map.version}`;
        if (kind === 'class') {
            return `rosetta-frida: class '${name}' not found ${where}.`;
        }
        // The 'method' | 'field' overload makes className non-optional, so the
        // fallback is unreachable; it replaces a blind `as string` cast with a
        // safe default.
        /* c8 ignore next */
        const onClass = className ?? '<unknown>';
        return `rosetta-frida: ${kind} '${name}' not found on class '${onClass}' ${where}.`;
    }
}

/**
 * Sentinel-aware wrappers. These honour the failurePolicy: when 'warn',
 * a miss returns a sentinel proxy (UnresolvedAccessError on access)
 * instead of throwing. Internal subsystems that want strict behaviour
 * should call the Resolver methods directly.
 *
 * The `policy` argument defaults to the resolver's own
 * {@link Resolver.failurePolicy}, so the session's configured policy
 * flows through automatically; pass an explicit policy only to override.
 */
export function resolveClassOrSentinel(
    resolver: Resolver,
    realName: string,
    policy: FailurePolicy = resolver.failurePolicy,
): ResolvedClass | ReturnType<typeof makeSentinel> {
    try {
        return resolver.resolveClass(realName);
    } catch (e) {
        if (policy === 'warn' && e instanceof ResolveError) {
            return makeSentinel(realName, 'class');
        }
        throw e;
    }
}

export function resolveMethodOrSentinel(
    resolver: Resolver,
    className: string,
    methodName: string,
    argTypes: readonly string[] | undefined,
    policy: FailurePolicy = resolver.failurePolicy,
): ResolvedMethod | ReturnType<typeof makeSentinel> {
    try {
        return resolver.resolveMethod(className, methodName, argTypes);
    } catch (e) {
        if (policy === 'warn' && e instanceof ResolveError) {
            return makeSentinel(`${className}.${methodName}`, 'method');
        }
        throw e;
    }
}

export function resolveFieldOrSentinel(
    resolver: Resolver,
    className: string,
    fieldName: string,
    policy: FailurePolicy = resolver.failurePolicy,
): ResolvedField | ReturnType<typeof makeSentinel> {
    try {
        return resolver.resolveField(className, fieldName);
    } catch (e) {
        if (policy === 'warn' && e instanceof ResolveError) {
            return makeSentinel(`${className}.${fieldName}`, 'field');
        }
        throw e;
    }
}
