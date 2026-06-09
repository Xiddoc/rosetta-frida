/**
 * Diagnostics — the structured event channel (the home of `EventBus`).
 *
 * Subscribers get every resolve / health-check / detect / map-load /
 * signer-check / map-status event. Internally subsystems call `emit(...)`;
 * users subscribe via `rosetta.events.on(...)`.
 *
 * This module OWNS the implementation; all first-party importers reference
 * it directly (or via `./diagnostics/index.js` for the public surface).
 */

import type { DiagnosticEvent, EventListener } from '../types/events.js';

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

    /**
     * Emit an event to all subscribers.
     *
     * A throwing user listener must NOT abort the resolve hot path (emit is
     * called from inside `resolveClass/Method/Field`): one bad subscriber
     * would otherwise turn every resolution into a throw. We isolate each
     * listener in a try/catch and report its failure to the console without
     * letting it escape. Trace output is likewise isolated.
     */
    emit(event: DiagnosticEvent): void {
        if (this.traceEnabled) {
            try {
                traceWrite(formatEvent(event));
            } catch (e) {
                reportListenerError(e);
            }
        }
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (e) {
                reportListenerError(e);
            }
        }
    }

    /** Toggle stderr-trace mode. */
    setTrace(enabled: boolean): void {
        this.traceEnabled = enabled;
    }

    /**
     * Remove all subscribers and reset trace mode, leaving the bus fully
     * inert. Used when a session is disposed / superseded (L12): a cleared
     * bus must not keep tracing to stderr either, so a stale bus held by an
     * already-installed hook produces no further output of any kind.
     * Unsubscribe tokens returned by {@link on} before a `clear()` stay safe
     * no-ops afterward (`Set.delete` of an absent entry is harmless).
     */
    clear(): void {
        this.listeners.clear();
        this.traceEnabled = false;
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
            return `[rosetta] map-load ${event.app}@${event.version} schema=${event.schemaVersion} classes=${event.classCount} select=${event.selectionKind}`;
        }
        case 'signer-check': {
            const status = event.passed ? 'PASS' : 'FAIL';
            return `[rosetta] signer-check ${status} ${event.app} expected=${event.expected} signers=${event.actual.length} (${event.source})`;
        }
        case 'map-status': {
            const supersededBy =
                event.supersededBy !== undefined ? ` superseded_by=${event.supersededBy}` : '';
            return `[rosetta] map-status ${event.status.toUpperCase()} ${event.app}@${event.version}${supersededBy}`;
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

/**
 * Report a listener (or trace) failure without rethrowing. Best-effort —
 * if even the console call throws, there is nothing more we can do.
 */
function reportListenerError(error: unknown): void {
    try {
        console.error('[rosetta] diagnostic listener threw (suppressed):', error);
    } catch {
        // Nothing left to do; never let diagnostics abort the hot path.
    }
}

/** Create an EventBus with trace explicitly off. */
export function createSilentBus(): EventBus {
    const bus = new EventBus();
    bus.setTrace(false);
    return bus;
}
