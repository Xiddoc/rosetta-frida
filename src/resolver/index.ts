/**
 * Resolver subsystem — public re-exports + factory.
 *
 * Downstream subsystems import from here. The internals (sentinel,
 * signature parsing) are exposed for tier-3 callers and tests, but
 * the recommended entry point is `createResolver(map, options)`.
 */

import { EventBus } from '../log.js';
import type { RosettaMap } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import type { FailurePolicy } from '../types/session.js';
import { ResolverImpl } from './resolver.js';

export { ResolverImpl } from './resolver.js';
export {
    resolveClassOrSentinel,
    resolveMethodOrSentinel,
    resolveFieldOrSentinel,
} from './resolver.js';
export type { ResolverOptions } from './resolver.js';
export { makeSentinel, isSentinel, SENTINEL_REAL_NAME } from './sentinel.js';
export { parseSignatureArgs, toJvmDescriptor } from './signature.js';

/** Options accepted by `createResolver`. */
export interface CreateResolverOptions {
    /**
     * Where to emit resolution events. Optional — if not provided, the
     * factory wires up a fresh EventBus (which the caller can retrieve
     * later via `resolver.events`). Sharing a bus across subsystems is
     * the recommended pattern; the Session layer owns the canonical bus
     * once Wave 2 lands.
     */
    events?: EventBus;
    /** Failure policy for sentinel-aware wrappers. Default 'strict'. */
    failurePolicy?: FailurePolicy;
}

/**
 * Factory for the public Resolver interface. Hides the implementing
 * class so downstream code can be migrated without churn if/when the
 * internals change.
 */
export function createResolver(map: RosettaMap, options: CreateResolverOptions = {}): Resolver {
    const events = options.events ?? new EventBus();
    return new ResolverImpl({
        map,
        events,
        failurePolicy: options.failurePolicy ?? 'strict',
    });
}
