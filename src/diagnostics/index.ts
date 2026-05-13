/**
 * Diagnostics subsystem — public re-exports.
 *
 * Two consumers (per design §3.4):
 *   - Console: the EventBus's trace mode prints readable lines to stderr.
 *   - Programmatic: subscribers via `events.on(...)` get structured events.
 */

export { EventBus, formatEvent, createSilentBus } from './event-bus.js';
