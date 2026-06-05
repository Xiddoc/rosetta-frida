/**
 * Class proxy — the Tier-2 wrapper around `Java.use(obfName)`.
 *
 * Public contract: `ClassProxy` in `../types/proxy.ts`. Returned from
 * `rosetta.use(realFQN)`.
 *
 * Responsibilities:
 *
 *   - Wraps `Java.use(<obfuscated class name>)` and exposes that as
 *     `$native`.
 *   - Surfaces `$realName`, `$obfName`, `$resolver` metadata for
 *     tier-3 introspection.
 *   - `$new(...args)` constructs a Java instance (delegates to the
 *     native wrapper) and wraps the result in an InstanceProxy so
 *     instance-field reads translate through the Resolver.
 *   - `.class` passes through unchanged to the underlying Java
 *     `Class<?>` reflection object — users reading the Java class
 *     object expect that exact reference.
 *   - Any other property access (member real name) is resolved via the
 *     class's ClassEntry from the loaded map:
 *       * Real method names → MethodHandle (memoized per access).
 *       * Real (static) field names → FieldAccessor (memoized).
 *       * Unknown names → throws ResolveError via the Resolver, so the
 *         user gets a loud, scoped error citing the class and member.
 *
 * Memoization is per-proxy. Two calls to `rosetta.use(realName)` return
 * two different proxies (cheap), but member-access caching ensures
 * `Stub.requestTicket === Stub.requestTicket` within one proxy.
 */
import { defaultJavaBridge, javaBridgeFromUse, type JavaBridge } from '../java-bridge.js';
import type { ClassEntry, MethodEntry } from '../types/map.js';
import {
    ROSETTA_META,
    type ClassProxy,
    type FieldAccessor,
    type MethodHandle,
    type ProxyMeta,
} from '../types/proxy.js';
import type { Resolver } from '../types/resolver.js';
import { makeFieldAccessor } from './field-accessor.js';
import { makeInstanceProxy } from './instance-proxy.js';
import { makeMethodHandle } from './method-handle.js';
import { resolveClassOrSentinel } from '../resolver/resolver.js';
import { isSentinel } from '../resolver/sentinel.js';

/** Options accepted by `makeClassProxy`. */
export interface ClassProxyOptions {
    /**
     * Override the global `Java.use(...)` resolver. Tests pass a stub;
     * production code lets this default to the live Frida `Java.use`.
     *
     * Sugar over {@link ClassProxyOptions.javaBridge}: when set, it is
     * adapted to a {@link JavaBridge} internally. Prefer `javaBridge` for
     * new code; `javaUse` is retained for the `rosetta.use(name, { javaUse })`
     * ergonomic.
     */
    javaUse?: (obfName: string) => unknown;
    /**
     * The seam onto Frida's global `Java`. Defaults to the global-reading
     * {@link defaultJavaBridge}. Tests inject a fake bridge instead of
     * mutating `globalThis`.
     */
    javaBridge?: JavaBridge;
}

/**
 * Resolve the effective {@link JavaBridge} for a proxy: an explicit
 * `javaBridge` wins; otherwise a `javaUse` callable is adapted; otherwise
 * the global-reading default is used.
 */
function resolveBridge(options: ClassProxyOptions): JavaBridge {
    if (options.javaBridge !== undefined) return options.javaBridge;
    if (options.javaUse !== undefined) return javaBridgeFromUse(options.javaUse);
    return defaultJavaBridge;
}

/**
 * Build a ClassProxy for the given real fully-qualified class name.
 */
export function makeClassProxy(
    resolver: Resolver,
    realName: string,
    options: ClassProxyOptions = {},
): ClassProxy {
    const bridge = resolveBridge(options);

    // Honour the session failure policy at the class boundary: under
    // 'warn', an unknown class yields a sentinel (the resolver emits the
    // miss event) and the WHOLE proxy becomes that sentinel — any member
    // access or call throws UnresolvedAccessError clearly, rather than the
    // script blowing up at `rosetta.use(...)` time. Under 'strict' this
    // rethrows the ResolveError, matching the eager-resolve contract.
    const initial = resolveClassOrSentinel(resolver, realName);
    if (isSentinel(initial)) {
        return initial as unknown as ClassProxy;
    }

    // Mutable proxy state, re-derived whenever the resolver's cache epoch
    // moves (a tier-3 override invalidates caches and bumps the epoch).
    // Without this revalidation a live proxy built before an override would
    // keep handing back the pre-override class entry / native wrapper /
    // memoized member handles. See Resolver.cacheEpoch.
    let entry: ClassEntry;
    let obfName: string;
    let native: unknown;
    let epoch = -1;

    // Memoized per-member handles. Same real name → same handle object,
    // until an override forces a rebuild.
    const memberCache = new Map<string, MethodHandle | FieldAccessor<unknown>>();

    const metadata: Record<string, unknown> = {
        $realName: realName,
        get $obfName(): string {
            revalidate();
            return obfName;
        },
        get $native(): unknown {
            revalidate();
            return native;
        },
        $resolver: resolver,
        $new(...args: unknown[]): unknown {
            revalidate();
            const nativeWrapper = native as { $new: (...a: unknown[]) => unknown };
            const instance = nativeWrapper.$new(...args);
            return makeInstanceProxy(resolver, realName, instance);
        },
    };

    /**
     * Re-resolve the class (and rebuild the native wrapper + drop the
     * member cache) if the resolver's epoch has advanced since we last
     * looked. The first call (epoch === -1) performs the initial resolve.
     */
    function revalidate(): void {
        const current = resolver.cacheEpoch();
        if (current === epoch) return;
        const resolved = resolver.resolveClass(realName);
        entry = resolved.entry;
        obfName = resolved.obfName;
        native = bridge.use(obfName);
        memberCache.clear();
        epoch = current;
    }

    // Resolve eagerly so a bad real name (or a denied target) throws at
    // construction, matching the pre-revalidation contract.
    revalidate();

    /** True if the loaded class defines a real member named `prop`. */
    function mapDefines(prop: string): boolean {
        return entry.methods?.[prop] !== undefined || entry.fields?.[prop] !== undefined;
    }

    return new Proxy(metadata, {
        get(_t, prop): unknown {
            // Collision-proof metadata accessor: a Symbol can never clash
            // with a (string) map key, so tier-3 code can always reach the
            // proxy's own metadata here.
            if (prop === ROSETTA_META) {
                revalidate();
                const meta: ProxyMeta = { realName, obfName, native, resolver };
                return meta;
            }
            if (typeof prop !== 'string') {
                return undefined;
            }
            revalidate();
            // `$`-metadata accessors are ergonomic but must NOT shadow a
            // real map member of the same name — a community map that
            // happens to define `$native` / `$new` should still be
            // reachable. So a map-defined member wins; otherwise the
            // string metadata answers. (Use ROSETTA_META for the
            // guaranteed-metadata path.)
            if (prop in metadata && !mapDefines(prop)) {
                return metadata[prop];
            }
            // `.class` passes through to the underlying Java Class<?>
            // reflection object. This is the only non-metadata property
            // we intentionally surface without resolver translation.
            if (prop === 'class') {
                return (native as { class: unknown }).class;
            }
            const cached = memberCache.get(prop);
            if (cached !== undefined) {
                return cached;
            }
            // Dispatch: methods first (more common access path), then fields.
            const overloads = entry.methods?.[prop];
            if (overloads !== undefined) {
                // Pick the first overload's obfuscated name — multiple
                // overloads of a single real method name all share the
                // same underlying Frida method object (which then
                // exposes `.overloads` for disambiguation). We do NOT
                // call `resolver.resolveMethod(...)` here because that
                // raises `AmbiguousOverloadError` for multi-overload
                // methods, and *accessing* the method on the class
                // wrapper must always succeed — the ambiguity check
                // belongs on `.implementation`, not on the access.
                //
                // `overloads` is always a non-empty array post-validation
                // (the schema's `.min(1)` + single→array normalisation), so
                // `[0]` is defined; the assertion is for the type system.
                const first = overloads[0] as MethodEntry;
                const obfMethod = first.obfuscated;
                const handle = makeMethodHandle(resolver, realName, prop, native, obfMethod);
                memberCache.set(prop, handle);
                return handle;
            }
            const fieldEntry = entry.fields?.[prop];
            if (fieldEntry !== undefined) {
                const resolvedField = resolver.resolveField(realName, prop);
                const accessor = makeFieldAccessor(
                    resolver,
                    realName,
                    prop,
                    native,
                    resolvedField.obfName,
                );
                memberCache.set(prop, accessor);
                return accessor;
            }
            // Neither method nor field: ask the resolver for a method
            // so it throws a properly-scoped ResolveError (the Resolver
            // emits a 'miss' diagnostic event as part of throwing,
            // which is more useful than a bare throw here).
            return resolver.resolveMethod(realName, prop);
        },
    }) as ClassProxy;
}
