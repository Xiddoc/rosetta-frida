/**
 * Main entry point. Re-exports the public API.
 *
 * Wave 1 fills in: parse/load, resolver, marker.
 * Wave 2 fills in: session, proxy/use, hook, map, events.
 *
 * For Wave 0 this file is intentionally minimal — only type re-exports
 * and the error hierarchy are populated. The `rosetta` namespace itself
 * arrives once Wave 2 lands.
 */

export * from './errors.js';
export * from './types/index.js';
export { EventBus, formatEvent } from './log.js';
