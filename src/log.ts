/**
 * Compat shim — `EventBus` + `formatEvent` now live in
 * `diagnostics/event-bus.ts`.
 *
 * This module used to own the diagnostics implementation; it was moved into
 * the `diagnostics/` subsystem where it belongs. This re-export keeps the
 * historical `'../log.js'` import path stable for existing call sites.
 * Prefer importing from `'./diagnostics/index.js'` (or
 * `'../diagnostics/event-bus.js'`) in new code.
 */

export { EventBus, formatEvent, createSilentBus } from './diagnostics/event-bus.js';
