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
import type { ClassEntry } from '../types/map.js';
import type { ClassProxy, FieldAccessor, MethodHandle } from '../types/proxy.js';
import type { Resolver } from '../types/resolver.js';
import { makeFieldAccessor } from './field-accessor.js';
import { makeInstanceProxy } from './instance-proxy.js';
import { makeMethodHandle } from './method-handle.js';

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
    const resolved = resolver.resolveClass(realName);
    const entry: ClassEntry = resolved.entry;
    const obfName = resolved.obfName;

    const bridge = resolveBridge(options);
    const native = bridge.use(obfName);

    // Memoized per-member handles. Same real name → same handle object.
    const memberCache = new Map<string, MethodHandle | FieldAccessor<unknown>>();

    const metadata: Record<string, unknown> = {
        $realName: realName,
        $obfName: obfName,
        $native: native,
        $resolver: resolver,
        $new(...args: unknown[]): unknown {
            const nativeWrapper = native as { $new: (...a: unknown[]) => unknown };
            const instance = nativeWrapper.$new(...args);
            return makeInstanceProxy(resolver, realName, instance);
        },
    };

    return new Proxy(metadata, {
        get(_t, prop): unknown {
            if (typeof prop !== 'string') {
                return undefined;
            }
            // Metadata + $new shortcut.
            if (prop in metadata) {
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
            const methodEntry = entry.methods?.[prop];
            if (methodEntry !== undefined) {
                // Pick the first overload's obfuscated name — multiple
                // overloads of a single real method name all share the
                // same underlying Frida method object (which then
                // exposes `.overloads` for disambiguation). We do NOT
                // call `resolver.resolveMethod(...)` here because that
                // raises `AmbiguousOverloadError` for multi-overload
                // methods, and *accessing* the method on the class
                // wrapper must always succeed — the ambiguity check
                // belongs on `.implementation`, not on the access.
                const first = Array.isArray(methodEntry) ? methodEntry[0] : methodEntry;
                // The schema validator (src/validate/schema.ts) rejects
                // empty overload arrays via `.min(1)`, so `first` is
                // always defined; the assertion is for the type system.
                const obfMethod = (first as { obfuscated: string }).obfuscated;
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
