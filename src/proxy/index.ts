/**
 * Proxy layer — public re-exports.
 *
 * The proxy layer is the Tier-2 user-facing surface: `rosetta.use(...)`
 * returns the ClassProxy built here, and instance constructions
 * (`$new`) return InstanceProxy objects.
 *
 * Higher tiers (Tier-1 declarative API) and the session layer may
 * compose these factories directly when they need a single hook to
 * own its own proxy without going through the global `rosetta.use`.
 */

export { makeClassProxy } from './class-proxy.js';
export type { ClassProxyOptions } from './class-proxy.js';
export { makeInstanceProxy } from './instance-proxy.js';
export { makeMethodHandle } from './method-handle.js';
export { makeFieldAccessor } from './field-accessor.js';
