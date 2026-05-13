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
import type { FieldAccessor, InstanceProxy } from '../types/proxy.js';
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
    const obfName = resolver.resolveClass(realName).obfName;

    // Per-instance memoization of field accessors so repeated reads of
    // the same field return the same wrapper object.
    const fieldCache = new Map<string, FieldAccessor<unknown>>();

    const metadata: Record<string, unknown> = {
        $realName: realName,
        $obfName: obfName,
        $native: instance,
    };

    const target = metadata as Record<string, unknown> & { [key: string]: unknown };

    return new Proxy(target, {
        get(_t, prop): unknown {
            if (typeof prop !== 'string') {
                return undefined;
            }
            if (prop in metadata) {
                return metadata[prop];
            }
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
