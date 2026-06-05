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

describe('EventBus.emit — listener isolation', () => {
    it('does not let a throwing listener abort emit or other listeners', () => {
        const bus = new EventBus();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        let secondRan = false;
        bus.on(() => {
            throw new Error('listener boom');
        });
        bus.on(() => {
            secondRan = true;
        });
        // emit must not throw, and the second listener still runs.
        expect(() => bus.emit({ type: 'resolve', name: 'X', source: 'map' })).not.toThrow();
        expect(secondRan).toBe(true);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('never throws even when the error reporter (console.error) itself throws', () => {
        const bus = new EventBus();
        // console.error throws on EVERY call: both the listener-error report
        // and any subsequent attempt must be swallowed.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {
            throw new Error('console boom');
        });
        bus.on(() => {
            throw new Error('listener boom');
        });
        expect(() => bus.emit({ type: 'resolve', name: 'X', source: 'map' })).not.toThrow();
        spy.mockRestore();
    });

    it('isolates a throwing trace formatter from listeners', () => {
        const bus = new EventBus();
        bus.setTrace(true);
        // Force console.error (used by traceWrite) to throw the FIRST time, but
        // swallow any later calls so the isolation path's own "listener threw"
        // console.error doesn't leak to real stderr (it would otherwise pollute
        // CI output even though the test passes).
        let calls = 0;
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {
            calls += 1;
            if (calls === 1) throw new Error('trace boom');
        });
        let delivered = false;
        bus.on(() => {
            delivered = true;
        });
        expect(() =>
            bus.emit({ type: 'detect', app: 'a', version: '1', source: 'auto' }),
        ).not.toThrow();
        expect(delivered).toBe(true);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('EventBus subscription management', () => {
    it('onType only fires for the matching event type and unsubscribes', () => {
        const bus = new EventBus();
        const seen: string[] = [];
        const off = bus.onType('detect', (e) => seen.push(e.app));
        bus.emit({ type: 'resolve', name: 'X', source: 'map' });
        bus.emit({ type: 'detect', app: 'com.example.app', version: '1', source: 'auto' });
        expect(seen).toEqual(['com.example.app']);
        off();
        bus.emit({ type: 'detect', app: 'again', version: '2', source: 'auto' });
        expect(seen).toEqual(['com.example.app']);
    });

    it('on returns an unsubscribe and clear removes all', () => {
        const bus = new EventBus();
        let count = 0;
        const off = bus.on(() => (count += 1));
        bus.emit({ type: 'resolve', name: 'X', source: 'map' });
        off();
        bus.on(() => (count += 1));
        bus.clear();
        bus.emit({ type: 'resolve', name: 'Y', source: 'map' });
        expect(count).toBe(1);
    });
});

describe('formatEvent — all variants', () => {
    it('formats a resolve miss and a resolve hit with overload', () => {
        expect(formatEvent({ type: 'resolve', name: 'M', miss: true, source: 'map' })).toContain(
            'MISS',
        );
        expect(
            formatEvent({
                type: 'resolve',
                name: 'M',
                classScope: 'C',
                obfName: 'a',
                source: 'cache',
                overloadSignature: '()V',
            }),
        ).toContain('C.M');
    });

    it('formats health-check, map-load, signer-check', () => {
        expect(
            formatEvent({
                type: 'health-check',
                passed: false,
                rate: 0.5,
                threshold: 0.8,
                failedEntries: ['x'],
            }),
        ).toContain('FAIL');
        expect(
            formatEvent({
                type: 'map-load',
                app: 'a',
                version: '1',
                classCount: 3,
                schemaVersion: 2,
            }),
        ).toContain('map-load');
        expect(
            formatEvent({
                type: 'signer-check',
                passed: true,
                app: 'a',
                expected: 'x',
                actual: ['x'],
                source: 'signingInfo',
            }),
        ).toContain('signer-check PASS');
    });
});
