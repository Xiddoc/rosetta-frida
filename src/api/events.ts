/**
 * Tier 3 `rosetta.events.*` — programmatic subscription to the
 * session's diagnostic bus (design §3.4, §4.3).
 *
 * Both methods delegate to the session's `EventBus`. `on(...)` gets
 * every event; `onType(...)` filters by discriminator. Both return an
 * unsubscribe function — exactly the EventBus contract.
 */

import type { DiagnosticEvent, EventListener } from '../types/events.js';
import type { RosettaSession } from '../session/session.js';

/** The shape of the Tier 3 `rosetta.events` surface. */
export interface EventsApi {
    /** Subscribe to all events. Returns an unsubscribe function. */
    on(listener: EventListener): () => void;
    /** Subscribe to events with a specific `type`. Returns an unsubscribe function. */
    onType<T extends DiagnosticEvent['type']>(
        type: T,
        listener: EventListener<Extract<DiagnosticEvent, { type: T }>>,
    ): () => void;
}

/**
 * Build a Tier 3 `events` surface bound to a session.
 *
 * Like the map surface, the session is explicit in V1; the ambient-
 * session variant is integration-time work.
 */
export function createEventsApi(session: RosettaSession): EventsApi {
    return {
        on: (listener) => session.events.on(listener),
        onType: (type, listener) => session.events.onType(type, listener),
    };
}
