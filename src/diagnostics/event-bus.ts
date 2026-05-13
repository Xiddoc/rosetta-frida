/**
 * Stable import path for the EventBus + formatter.
 *
 * `src/log.ts` is the source of truth; this module is a re-export so
 * downstream agents (Wave 2 session/proxy/hook layers) have a single
 * `'../diagnostics/event-bus.js'` import that won't move even if the
 * internals shuffle.
 *
 * Also provides one small ergonomics helper —
 * `createSilentBus()` — for tests that want a bus and don't care about
 * trace output. The Resolver's own tests use the regular EventBus so
 * they exercise the full emit path, but downstream subsystems benefit
 * from a one-liner.
 */

import { EventBus, formatEvent } from '../log.js';

export { EventBus, formatEvent };

/** Create an EventBus with trace explicitly off. */
export function createSilentBus(): EventBus {
    const bus = new EventBus();
    bus.setTrace(false);
    return bus;
}
