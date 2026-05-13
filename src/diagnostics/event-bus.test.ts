/**
 * Tests for the diagnostics module's re-exports and tiny ergonomics helper.
 *
 * The EventBus itself is exercised by tests/smoke.test.ts; this file
 * verifies that the diagnostics module surfaces the right symbols and
 * that `createSilentBus` returns a bus with trace explicitly disabled.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus, formatEvent, createSilentBus } from './event-bus.js';

describe('diagnostics re-exports', () => {
    it('exports EventBus', () => {
        const bus = new EventBus();
        expect(bus).toBeInstanceOf(EventBus);
    });

    it('exports formatEvent', () => {
        const line = formatEvent({ type: 'resolve', name: 'X', obfName: 'a', source: 'map' });
        expect(line).toMatch(/X.*a.*map/);
    });
});

describe('createSilentBus', () => {
    it('returns a usable EventBus', () => {
        const bus = createSilentBus();
        expect(bus).toBeInstanceOf(EventBus);
    });

    it('has trace disabled — no stderr output on emit', () => {
        const bus = createSilentBus();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        bus.emit({ type: 'resolve', name: 'X', source: 'map' });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('still delivers events to subscribers', () => {
        const bus = createSilentBus();
        let seen = 0;
        bus.on(() => {
            seen += 1;
        });
        bus.emit({ type: 'resolve', name: 'X', source: 'map' });
        expect(seen).toBe(1);
    });
});
