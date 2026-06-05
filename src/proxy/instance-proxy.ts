/**
 * Instance proxy — wraps a Java instance reference (the value of
 * `Java.use(obfClass).$new(...)` or `Java.cast(...)`) for real-name
 * field access.
 *
 * Public contract: `InstanceProxy` in `../types/proxy.ts`.
 *
 * Instance method access at Tier 2 is uncommon (users hooking
 * `Stub.method.implementation = function(...)` work against the
 * class wrapper, and inside the implementation `this` is the same
 * underlying Java instance — so `this.someField.value` works through
 * the same translation path). The instance proxy here exists primarily
 * for instance-field reads/writes outside a hook body and inside
 * Tier-3 escape hatches.
 *
 * Members that begin with `$` are reserved metadata accessors and pass
 * through to the proxy target (no map lookup). All other member reads
 * are resolved as fields via the Resolver; reads return a
 * FieldAccessor; writes to `.value` round-trip through the underlying
 * Java field.
 */
import { makeFieldAccessor } from './field-accessor.js';
import {
    ROSETTA_META,
    type FieldAccessor,
    type InstanceProxy,
    type ProxyMeta,
} from '../types/proxy.js';
import type { Resolver } from '../types/resolver.js';

/**
 * Build an InstanceProxy for the given instance.
 *
 * @param resolver — the Resolver to translate real → obf names.
 * @param realName — the real fully-qualified class name. Stored on
 *                   `$realName` for tier-3 inspection.
 * @param instance — the Frida-side Java instance object (returned from
 *                   `$new(...)`, `Java.cast(...)`, or a hook's `this`).
 */
export function makeInstanceProxy(
    resolver: Resolver,
    realName: string,
    instance: unknown,
): InstanceProxy {
    // Per-instance memoization of field accessors so repeated reads of
    // the same field return the same wrapper object — dropped when the
    // resolver's cache epoch moves (a tier-3 override) so a re-mapped
    // field's obfuscated name is picked up by a live instance proxy.
    const fieldCache = new Map<string, FieldAccessor<unknown>>();
    // Resolve eagerly so a bad real name throws at construction (matching
    // the prior contract); the result is re-read lazily via $obfName.
    resolver.resolveClass(realName);
    let epoch = resolver.cacheEpoch();

    /** Drop the field cache if an override invalidated resolver caches. */
    function revalidate(): void {
        const current = resolver.cacheEpoch();
        if (current === epoch) return;
        fieldCache.clear();
        epoch = current;
    }

    const metadata: Record<string, unknown> = {
        $realName: realName,
        get $obfName(): string {
            return resolver.resolveClass(realName).obfName;
        },
        $native: instance,
    };

    const target = metadata as Record<string, unknown> & { [key: string]: unknown };

    return new Proxy(target, {
        get(_t, prop): unknown {
            // Collision-proof metadata accessor (see class-proxy).
            if (prop === ROSETTA_META) {
                const meta: ProxyMeta = {
                    realName,
                    obfName: resolver.resolveClass(realName).obfName,
                    native: instance,
                    resolver,
                };
                return meta;
            }
            if (typeof prop !== 'string') {
                return undefined;
            }
            // A real map field of the same name as a `$`-metadata accessor
            // must not be shadowed; the field wins, metadata is the
            // fallback. ROSETTA_META is the guaranteed-metadata path.
            if (prop in metadata && resolver.lookupField(realName, prop) === undefined) {
                return metadata[prop];
            }
            revalidate();
            const cached = fieldCache.get(prop);
            if (cached !== undefined) {
                return cached;
            }
            const resolved = resolver.resolveField(realName, prop);
            const accessor = makeFieldAccessor(
                resolver,
                realName,
                prop,
                instance,
                resolved.obfName,
            );
            fieldCache.set(prop, accessor);
            return accessor;
        },
    }) as InstanceProxy;
}
