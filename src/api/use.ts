/**
 * Tier-2 API — `rosetta.use(realName, options)`.
 *
 * Mirrors Frida's `Java.use(obfName)` shape, but takes a *real* name
 * and translates it through the loaded Resolver. The returned
 * `ClassProxy` exposes methods and (static) fields by real name,
 * memoizing per-member access.
 *
 * V1 takes the Resolver as an explicit option. Once the Session layer
 * (Wave 2G) lands, the session-driven default will let users call
 * `rosetta.use(realName)` without threading a Resolver through every
 * call site; that path is intentionally not implemented here so this
 * agent's territory stays bounded and the contract for the session
 * default lives entirely in Wave 2G.
 */
import type { Resolver } from '../types/resolver.js';
import type { ClassProxy } from '../types/proxy.js';
import { makeClassProxy } from '../proxy/class-proxy.js';
import type { ClassProxyOptions } from '../proxy/class-proxy.js';

/** Options accepted by `use(...)`. */
export interface UseOptions extends ClassProxyOptions {
    /**
     * The Resolver to translate real → obf names through. Required in
     * V1. The Session layer (Wave 2G) will introduce an ambient
     * default that drops this requirement.
     */
    resolver: Resolver;
}

/**
 * Build a ClassProxy for the given real fully-qualified class name.
 *
 * @example
 *   const Stub = use('com.example.app.IRemoteService$Stub', { resolver });
 *   Stub.requestTicket
 *       .overload('android.os.Bundle', 'IServiceCallback')
 *       .implementation = function(b, cb) { ... };
 */
export function use(realName: string, options: UseOptions): ClassProxy {
    return makeClassProxy(options.resolver, realName, options);
}
