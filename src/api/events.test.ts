/**
 * Tests for the Tier 3 `rosetta.events.*` surface (createEventsApi).
 *
 * Delegates to the session's EventBus. Verify both subscription
 * variants + their unsubscribe-fn contracts.
 */

import { describe, it, expect } from 'vitest';
import type { DiagnosticEvent } from '../types/events.js';
import type { RosettaMap } from '../types/map.js';
import { createSession } from '../session/session.js';
import type { HealthCheckJavaApi } from '../session/health-check.js';
import { createEventsApi } from './events.js';

function buildMap(): RosettaMap {
    return {
        schema_version: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: { 'com.example.app.Foo': { obfuscated: 'aaaa' } },
    };
}

function makeSession() {
    const healthCheckJavaApi: HealthCheckJavaApi = { use: () => ({}) };
    return createSession({
        map: buildMap(),
        app: 'com.example.app',
        version: '1.2.3',
        healthCheckJavaApi,
    });
}

describe('createEventsApi', () => {
    it('on subscribes to all events emitted on the session bus', () => {
        const session = makeSession();
        const api = createEventsApi(session);
        const seen: DiagnosticEvent[] = [];
        const off = api.on((e) => seen.push(e));
        // Resolve triggers a resolve event.
        session.resolver.resolveClass('com.example.app.Foo');
        expect(seen.some((e) => e.type === 'resolve')).toBe(true);
        off();
        const sizeAfterUnsub = seen.length;
        session.resolver.resolveClass('com.example.app.Foo');
        expect(seen.length).toBe(sizeAfterUnsub);
    });

    it('onType filters by discriminator', () => {
        const session = makeSession();
        const api = createEventsApi(session);
        const resolves: DiagnosticEvent[] = [];
        const off = api.onType('resolve', (e) => resolves.push(e));
        session.resolver.resolveClass('com.example.app.Foo');
        expect(resolves.length).toBeGreaterThan(0);
        for (const e of resolves) {
            expect(e.type).toBe('resolve');
        }
        off();
        const sizeAfterUnsub = resolves.length;
        session.resolver.resolveClass('com.example.app.Foo');
        expect(resolves.length).toBe(sizeAfterUnsub);
    });

    it('onType ignores events of other types', () => {
        const session = makeSession();
        const api = createEventsApi(session);
        const detects: DiagnosticEvent[] = [];
        const off = api.onType('detect', (e) => detects.push(e));
        session.resolver.resolveClass('com.example.app.Foo');
        expect(detects.length).toBe(0);
        off();
    });
});
