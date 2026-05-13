/**
 * Sentinel for the `failurePolicy: 'warn'` deferred-error path.
 *
 * When the Resolver can't satisfy a lookup under 'warn' policy, instead
 * of throwing immediately at the call site, it emits a miss event and
 * returns a sentinel. The sentinel is a Proxy that throws
 * UnresolvedAccessError on every property access (and every call) —
 * so the failure surfaces clearly the moment a downstream caller
 * actually tries to use the unresolved entity, with the unresolved
 * real name preserved in the thrown error.
 *
 * This keeps tier-1 / tier-2 hook scripts from blowing up at module
 * load time when one entry is stale, while still loudly signalling
 * the problem at the point of misuse.
 */

import { UnresolvedAccessError } from '../errors.js';

/** Internal symbol-keyed marker for detecting sentinels at runtime. */
const SENTINEL_MARKER = Symbol.for('rosetta-frida.sentinel');

/** Public accessor to read the real name a sentinel was created for. */
export const SENTINEL_REAL_NAME = Symbol.for('rosetta-frida.sentinel.realName');

/**
 * Build a sentinel proxy that throws UnresolvedAccessError on use.
 *
 * The proxy is callable (a Function target) so consumers that treat
 * the sentinel as a method handle also throw — important because
 * tier-2 callers commonly do `Stub.requestTicket.overload(...)` on
 * whatever the Resolver returned, and both the method access and the
 * subsequent call must surface the same loud failure.
 */
export function makeSentinel(
    realName: string,
    kind: 'class' | 'method' | 'field' | 'type',
): {
    [SENTINEL_REAL_NAME]: string;
    [key: string]: unknown;
} {
    const message = `rosetta-frida: ${kind} '${realName}' is unresolved (failurePolicy='warn'). Accessing or invoking the sentinel returned for it is an error.`;

    const refuse = (): never => {
        throw new UnresolvedAccessError(message, realName);
    };

    // Function target so the Proxy `apply` trap fires on call. The
    // target itself throws too — defensive, in case anything ever
    // unwraps the proxy via Reflect / Function.prototype.bind.
    const target = refuse as unknown as {
        [SENTINEL_REAL_NAME]: string;
        [key: string]: unknown;
    };

    const handler: ProxyHandler<typeof target> = {
        get(_t, prop) {
            if (prop === SENTINEL_REAL_NAME) {
                return realName;
            }
            if (prop === SENTINEL_MARKER) {
                return true;
            }
            return refuse();
        },
        set: refuse,
        apply: refuse,
        has: refuse,
    };

    return new Proxy(target, handler);
}

/** True if the given value is a sentinel (any kind). */
export function isSentinel(value: unknown): boolean {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return false;
    }
    try {
        // Reading the marker through the proxy returns true without throwing;
        // reading anything else throws. Wrap in try in case a future
        // sentinel-like object throws on the marker too.
        return (value as { [SENTINEL_MARKER]?: unknown })[SENTINEL_MARKER] === true;
    } catch {
        return false;
    }
}
