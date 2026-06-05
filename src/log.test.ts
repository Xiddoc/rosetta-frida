/**
 * The `log.ts` compat shim must keep re-exporting the diagnostics symbols
 * from their new home (`diagnostics/event-bus.ts`) so historical
 * `'../log.js'` imports stay valid.
 */

import { describe, it, expect } from 'vitest';
import { EventBus, formatEvent, createSilentBus } from './log.js';
import {
    EventBus as CanonicalEventBus,
    formatEvent as canonicalFormatEvent,
    createSilentBus as canonicalCreateSilentBus,
} from './diagnostics/event-bus.js';

describe('log.ts compat shim', () => {
    it('re-exports the same symbols as diagnostics/event-bus', () => {
        expect(EventBus).toBe(CanonicalEventBus);
        expect(formatEvent).toBe(canonicalFormatEvent);
        expect(createSilentBus).toBe(canonicalCreateSilentBus);
    });

    it('the re-exported EventBus is constructible', () => {
        expect(new EventBus()).toBeInstanceOf(CanonicalEventBus);
    });
});
