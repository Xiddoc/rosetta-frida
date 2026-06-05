/**
 * Diagnostics — the structured event channel.
 *
 * Subscribers get every resolve / health-check / detect / map-load event.
 * Internally subsystems call `emit(...)`; users subscribe via
 * `rosetta.events.on(...)` (Wave 2G owns the user-facing surface).
 */

import type { DiagnosticEvent, EventListener } from './types/events.js';

/**
 * A small event emitter. We don't use Node's EventEmitter because we want
 * to stay strictly typed and run inside Frida's JS sandbox (no Node stdlib).
 */
export class EventBus {
    private readonly listeners = new Set<EventListener>();
    private traceEnabled = false;

    /** Subscribe to all events. Returns an unsubscribe function. */
    on(listener: EventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Subscribe to a specific event type. Returns an unsubscribe function. */
    onType<T extends DiagnosticEvent['type']>(
        type: T,
        listener: EventListener<Extract<DiagnosticEvent, { type: T }>>,
    ): () => void {
        const wrapped: EventListener = (event) => {
            if (event.type === type) {
                listener(event as Extract<DiagnosticEvent, { type: T }>);
            }
        };
        return this.on(wrapped);
    }

    /** Emit an event to all subscribers. */
    emit(event: DiagnosticEvent): void {
        if (this.traceEnabled) {
            traceWrite(formatEvent(event));
        }
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    /** Toggle stderr-trace mode. */
    setTrace(enabled: boolean): void {
        this.traceEnabled = enabled;
    }

    /** Remove all subscribers (test helper). */
    clear(): void {
        this.listeners.clear();
    }
}

/**
 * Format an event as a single readable line for stderr trace mode.
 * Internal — exported for testing.
 */
export function formatEvent(event: DiagnosticEvent): string {
    switch (event.type) {
        case 'resolve': {
            const scope = event.classScope ? `${event.classScope}.` : '';
            const target = `${scope}${event.name}`;
            if (event.miss) {
                return `[rosetta] ${target} ← MISS`;
            }
            const overload = event.overloadSignature ? ` ${event.overloadSignature}` : '';
            return `[rosetta] ${target} ← ${event.obfName ?? '?'} (${event.source})${overload}`;
        }
        case 'health-check': {
            const status = event.passed ? 'PASS' : 'FAIL';
            const pct = (event.rate * 100).toFixed(1);
            return `[rosetta] health-check ${status} rate=${pct}% threshold=${(event.threshold * 100).toFixed(1)}% failures=${event.failedEntries.length}`;
        }
        case 'detect': {
            return `[rosetta] detect ${event.source}: ${event.app}@${event.version}`;
        }
        case 'map-load': {
            return `[rosetta] map-load ${event.app}@${event.version} schema=${event.schemaVersion} classes=${event.classCount}`;
        }
        case 'signer-check': {
            const status = event.passed ? 'PASS' : 'FAIL';
            return `[rosetta] signer-check ${status} ${event.app} expected=${event.expected} signers=${event.actual.length} (${event.source})`;
        }
    }
}

/**
 * Write a trace line. Both Frida's JS runtime and Node ship `console.error`,
 * so we call it unconditionally. Tests can spy on it.
 */
function traceWrite(line: string): void {
    console.error(line);
}
