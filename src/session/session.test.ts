/**
 * Tests for `RosettaSession` / `createSession`.
 *
 * Covers:
 *   - Explicit (app, version) → skips auto-detect.
 *   - Auto-detect through an injected Java API.
 *   - Single map vs. registry, exact vs. fuzzy.
 *   - Map / app / version mismatch → MapVersionMismatchError.
 *   - Health-check pass / fail (strict vs. warn).
 *   - skipHealthCheck.
 *   - trace mode propagates to the bus.
 *   - Resolver is wired to the session bus.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
    HealthCheckFailedError,
    MalformedSignerError,
    MapRetractedError,
    MapVersionMismatchError,
    MissingSignerError,
    SignerMismatchError,
} from '../errors.js';
import { resolveConfig } from '../config.js';
import { EventBus } from '../diagnostics/event-bus.js';
import type { DiagnosticEvent } from '../types/events.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { createSession, RosettaSession, isRegistry } from './session.js';
import type { AutoDetectJavaApi } from './auto-detect.js';
import type { HealthCheckJavaApi } from './health-check.js';
import {
    GET_SIGNING_CERTIFICATES,
    type SignerByteArray,
    type SignerJavaApi,
} from './signer-detect.js';

function buildMap(version: string, app = 'com.example.app', versionCode = 1): RosettaMap {
    return {
        schema_version: 4,
        version_code: versionCode,
        app,
        version,
        classes: {
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        },
    };
}

function makeAutoDetectJavaApi(
    app: string,
    version: string,
    versionCode?: number,
): AutoDetectJavaApi {
    return {
        use: () => ({
            currentApplication: () => ({
                getApplicationContext: () => ({
                    getPackageManager: () => ({
                        getPackageInfo: () => ({
                            versionName: { value: version },
                            ...(versionCode === undefined
                                ? {}
                                : { getLongVersionCode: () => versionCode }),
                        }),
                    }),
                }),
                getPackageName: () => app,
            }),
        }),
    };
}

/** Helper: build a health-check Java api that resolves a given set of obf names. */
function makeHealthJavaApi(knownObfNames: Iterable<string>): HealthCheckJavaApi {
    const known = new Set(knownObfNames);
    return {
        use: (name) => {
            if (known.has(name)) return {};
            throw new Error(`not registered: ${name}`);
        },
    };
}

function captureEvents(bus: EventBus): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    bus.on((e) => events.push(e));
    return events;
}

describe('createSession — explicit app/version', () => {
    it('skips auto-detect when both app and version are supplied', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.app).toBe('com.example.app');
        expect(session.version).toBe('1.2.3');
        expect(session.failurePolicy).toBe('warn');
        expect(session.versionMatch).toBe('exact');
        expect(session.healthy).toBe(true);
    });

    it('exposes the detected version_code on the public Session view', () => {
        const session = createSession({
            map: buildMap('1.2.3', 'com.example.app', 30405),
            app: 'com.example.app',
            version: '1.2.3',
            versionCode: 30405,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.versionCode).toBe(30405);
    });

    it('leaves versionCode undefined when none was supplied or detected', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.versionCode).toBeUndefined();
    });

    it('emits a detect event with source=override when given explicit values', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        const detect = captured.find((e) => e.type === 'detect');
        expect(detect).toBeDefined();
        expect(detect?.type).toBe('detect');
        if (detect?.type === 'detect') {
            expect(detect.source).toBe('override');
            expect(detect.app).toBe('com.example.app');
            expect(detect.version).toBe('1.2.3');
        }
    });

    it('emits a map-load event reflecting the bound map', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        const mapLoad = captured.find((e) => e.type === 'map-load');
        expect(mapLoad).toBeDefined();
        if (mapLoad?.type === 'map-load') {
            expect(mapLoad.classCount).toBe(2);
            expect(mapLoad.schemaVersion).toBe(4);
            // A single-map input is an exact selection.
            expect(mapLoad.selectionKind).toBe('exact');
        }
    });
});

describe('createSession — lifecycle status (#40)', () => {
    it('refuses a retracted map fail-closed with MapRetractedError', () => {
        const map = { ...buildMap('1.2.3'), status: 'retracted' as const };
        expect(() =>
            createSession({
                map,
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(MapRetractedError);
    });

    it('emits map-status before throwing so the reason is observable', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const map = { ...buildMap('1.2.3'), status: 'retracted' as const };
        expect(() =>
            createSession({
                map,
                app: 'com.example.app',
                version: '1.2.3',
                events,
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(MapRetractedError);
        expect(captured.some((e) => e.type === 'map-status' && e.status === 'retracted')).toBe(
            true,
        );
    });

    it('loads a superseded map but emits a map-status warning', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const map = {
            ...buildMap('1.2.3'),
            status: 'superseded' as const,
            superseded_by: 9,
        };
        const session = createSession({
            map,
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        // The session is still usable.
        expect(session.healthy).toBe(true);
        const ev = captured.find((e) => e.type === 'map-status');
        expect(ev).toBeDefined();
        if (ev && ev.type === 'map-status') {
            expect(ev.status).toBe('superseded');
            expect(ev.supersededBy).toBe(9);
        }
    });

    it('treats an active (or absent) status as a no-op (no map-status event)', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: { ...buildMap('1.2.3'), status: 'active' as const },
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(captured.some((e) => e.type === 'map-status')).toBe(false);
    });
});

describe('createSession — auto-detect', () => {
    it('runs the auto-detect chain when no app/version is supplied', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            autoDetectJavaApi: makeAutoDetectJavaApi('com.example.app', '1.2.3'),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.app).toBe('com.example.app');
        expect(session.version).toBe('1.2.3');
    });

    it('emits a detect event with source=auto', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: buildMap('1.2.3'),
            events,
            autoDetectJavaApi: makeAutoDetectJavaApi('com.example.app', '1.2.3'),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        const detect = captured.find((e) => e.type === 'detect');
        if (detect?.type === 'detect') {
            expect(detect.source).toBe('auto');
        } else {
            throw new Error('detect event not emitted');
        }
    });

    it('user-supplied app overrides the detected app (source=override)', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            events,
            autoDetectJavaApi: makeAutoDetectJavaApi('com.other.app', '1.2.3'),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.app).toBe('com.example.app');
        expect(session.version).toBe('1.2.3');
        const detect = captured.find((e) => e.type === 'detect');
        if (detect?.type === 'detect') {
            expect(detect.source).toBe('override');
        }
    });

    it('user-supplied version overrides the detected version (source=override)', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            version: '1.2.3',
            autoDetectJavaApi: makeAutoDetectJavaApi('com.example.app', '9.9.9'),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.app).toBe('com.example.app');
        expect(session.version).toBe('1.2.3');
    });
});

describe('createSession — mismatch detection', () => {
    it('throws MapVersionMismatchError on app mismatch', () => {
        expect(() =>
            createSession({
                map: buildMap('1.2.3', 'com.other.app'),
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(MapVersionMismatchError);
    });

    it('throws MapVersionMismatchError on version mismatch (exact mode)', () => {
        expect(() =>
            createSession({
                map: buildMap('1.2.4'),
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(MapVersionMismatchError);
    });

    it('carries the structured context on a mismatch', () => {
        try {
            createSession({
                map: buildMap('1.2.4'),
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapVersionMismatchError);
            if (e instanceof MapVersionMismatchError) {
                expect(e.detectedApp).toBe('com.example.app');
                expect(e.detectedVersion).toBe('1.2.3');
                expect(e.mapApp).toBe('com.example.app');
                expect(e.mapVersion).toBe('1.2.4');
            }
        }
    });
});

describe('createSession — registry input', () => {
    it('picks the right map by exact version', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.1.0',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.1.0');
    });

    it('throws in exact mode if the registry has no matching version', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        expect(() =>
            createSession({
                map: registry,
                app: 'com.example.app',
                version: '1.5.0',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(/no map for version '1\.5\.0'/);
    });

    it('falls back to fuzzy match when versionMatch is fuzzy', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
            '2.0.0': buildMap('2.0.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.1.1',
            versionMatch: 'fuzzy',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.1.0');
    });

    it('accepts the object-form versionMatch ({ strategy: "fuzzy" })', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.1.1',
            versionMatch: { strategy: 'fuzzy' },
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.1.0');
    });

    it('selects via an opt-in versionRange', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.5.0': buildMap('1.5.0'),
            '9.0.0': buildMap('9.0.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.4.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' } },
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        // 1.5.0 (Δ=[0,1,0]) is closest to 1.4.0 inside [1.0.0, 2.0.0].
        expect(session.map.version).toBe('1.5.0');
    });

    it('accepts a code-range pick whose version_code is FAR from the detected code and reports it', () => {
        // Detected code 100000 is nowhere near any map; the code range
        // [1, 1000] admits two maps and picks the one closest to 100000 (code
        // 999). The pick's version_code (999) is FAR from detected (100000) yet
        // accepted — that is the opt-in's purpose — and the map-load event
        // reports selectionKind 'code-range' so it is distinguishable from a
        // nearest guess (issue #22 major gap 2).
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 1),
            '2.0.0': buildMap('2.0.0', 'com.example.app', 999),
        };
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: 'whatever',
            versionCode: 100000,
            versionMatch: { versionCodeRange: { min: 1, max: 1000 } },
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version_code).toBe(999);
        const mapLoad = captured.find((e) => e.type === 'map-load');
        if (mapLoad?.type === 'map-load') {
            expect(mapLoad.selectionKind).toBe('code-range');
        } else {
            throw new Error('expected a map-load event');
        }
    });

    it('emits selectionKind "label-range" for a label-range pick', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.5.0': buildMap('1.5.0'),
        };
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.4.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' } },
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        const mapLoad = captured.find((e) => e.type === 'map-load');
        if (mapLoad?.type === 'map-load') {
            expect(mapLoad.selectionKind).toBe('label-range');
        } else {
            throw new Error('expected a map-load event');
        }
    });

    it('accepts a versionRange pick within an opt-in maxDistance ceiling', () => {
        // Now that the ceiling applies to the label-range tier: range admits
        // 1.5.0 (Δ=[0,1,0] to 1.4.0, major delta 0 <= 1) → accepted.
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.5.0': buildMap('1.5.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.4.0',
            versionMatch: { versionRange: { min: '1.0.0', max: '2.0.0' }, maxDistance: 1 },
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.5.0');
    });

    it('rejects a versionRange pick that exceeds the maxDistance ceiling', () => {
        const registry: RosettaMapRegistry = {
            '5.0.0': buildMap('5.0.0'),
            '6.0.0': buildMap('6.0.0'),
        };
        expect(() =>
            createSession({
                map: registry,
                app: 'com.example.app',
                version: '1.0.0',
                versionMatch: { versionRange: { min: '5.0.0', max: '6.0.0' }, maxDistance: 1 },
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(/exceeds the configured maxDistance of 1/);
    });

    it('honours the typed config versionMatching default when versionMatch is omitted', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            version: '1.1.1',
            config: resolveConfig({ versionMatching: { strategy: 'fuzzy' } }),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.1.0');
    });

    it('per-session versionMatch overrides the config default (explicit exact wins)', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0'),
            '1.1.0': buildMap('1.1.0'),
        };
        expect(() =>
            createSession({
                map: registry,
                app: 'com.example.app',
                version: '1.1.1',
                // Config says fuzzy, but the explicit per-session 'exact' wins
                // → fail-hard on the miss.
                config: resolveConfig({ versionMatching: { strategy: 'fuzzy' } }),
                versionMatch: 'exact',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(/no map for version '1\.1\.1'/);
    });

    it('config default of exact still fails hard on a miss (default-preserving)', () => {
        const registry: RosettaMapRegistry = { '1.0.0': buildMap('1.0.0') };
        expect(() =>
            createSession({
                map: registry,
                app: 'com.example.app',
                version: '2.0.0',
                config: resolveConfig(),
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            }),
        ).toThrow(/no map for version '2\.0\.0'/);
    });
});

describe('createSession — version_code selection (authoritative)', () => {
    it('selects a registry map by detected version_code, ignoring the label', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
            '1.1.0': buildMap('1.1.0', 'com.example.app', 110),
        };
        const session = createSession({
            map: registry,
            // Auto-detect reports code 110 but a label that wouldn't match.
            autoDetectJavaApi: makeAutoDetectJavaApi('com.example.app', 'marketing-name', 110),
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.1.0');
    });

    it('accepts a single map when the detected version_code matches even if labels differ', () => {
        const session = createSession({
            map: buildMap('1.2.3', 'com.example.app', 999),
            app: 'com.example.app',
            version: 'different-label',
            versionCode: 999,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version_code).toBe(999);
    });

    it('throws on a version_code mismatch even when version labels are equal', () => {
        try {
            createSession({
                map: buildMap('1.2.3', 'com.example.app', 100),
                app: 'com.example.app',
                version: '1.2.3',
                versionCode: 999,
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(MapVersionMismatchError);
            expect((e as Error).message).toMatch(/code 999/);
            expect((e as Error).message).toMatch(/code 100/);
        }
    });

    it('tolerates a version_code mismatch when the pick itself is fuzzy', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 100),
            '1.1.0': buildMap('1.1.0', 'com.example.app', 110),
        };
        const session = createSession({
            map: registry,
            app: 'com.example.app',
            // Code 999 is absent AND the label is non-exact → a genuine fuzzy
            // pick (nearest label), under which the code mismatch is tolerated.
            version: '1.0.5',
            versionCode: 999,
            versionMatch: 'fuzzy',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.map.version).toBe('1.0.0');
    });
});

describe('createSession — health check', () => {
    it('emits a passing health-check event when all classes resolve', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.healthy).toBe(true);
        const hc = captured.find((e) => e.type === 'health-check');
        if (hc?.type === 'health-check') {
            expect(hc.passed).toBe(true);
            expect(hc.rate).toBe(1);
            expect(hc.failedEntries).toEqual([]);
        } else {
            throw new Error('health-check event not emitted');
        }
    });

    it('emits a failing event but proceeds in warn mode (default)', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        // Only 'aaaa' resolves; 'bbbb' does not.
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa']),
        });
        expect(session.healthy).toBe(false);
        const hc = captured.find((e) => e.type === 'health-check');
        if (hc?.type === 'health-check') {
            expect(hc.passed).toBe(false);
            expect(hc.failedEntries).toEqual(['com.example.app.Bar']);
        }
    });

    it('throws HealthCheckFailedError in strict mode', () => {
        expect(() =>
            createSession({
                map: buildMap('1.2.3'),
                app: 'com.example.app',
                version: '1.2.3',
                failurePolicy: 'strict',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa']),
            }),
        ).toThrow(HealthCheckFailedError);
    });

    it('carries failure metadata on HealthCheckFailedError', () => {
        try {
            createSession({
                map: buildMap('1.2.3'),
                app: 'com.example.app',
                version: '1.2.3',
                failurePolicy: 'strict',
                healthCheckJavaApi: makeHealthJavaApi([]),
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(HealthCheckFailedError);
            if (e instanceof HealthCheckFailedError) {
                expect(e.rate).toBe(0);
                expect(e.failedEntries).toContain('com.example.app.Foo');
            }
        }
    });

    it('skips the health check when skipHealthCheck is true', () => {
        // Bad health Java api would normally fail — should not even be consulted.
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            skipHealthCheck: true,
            failurePolicy: 'strict',
            healthCheckJavaApi: makeHealthJavaApi([]),
        });
        expect(session.healthy).toBe(true);
    });

    it('does not emit a health-check event when skipped', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            skipHealthCheck: true,
            events,
        });
        expect(captured.find((e) => e.type === 'health-check')).toBeUndefined();
    });

    it('honours an explicit healthCheckThreshold', () => {
        // Only one class resolves; rate = 0.5. Threshold 0.4 → passes.
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckThreshold: 0.4,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa']),
        });
        expect(session.healthy).toBe(true);
    });
});

describe('createSession — trace + bus + resolver', () => {
    it('enables trace mode on the bus when trace=true', () => {
        const events = new EventBus();
        let traced = false;
        // Wrap setTrace observation by spying via a custom bus.
        const origSet = events.setTrace.bind(events);
        events.setTrace = (enabled: boolean) => {
            if (enabled) traced = true;
            origSet(enabled);
        };
        createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            trace: true,
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(traced).toBe(true);
    });

    it('does not enable trace by default', () => {
        const events = new EventBus();
        let setCount = 0;
        events.setTrace = () => {
            setCount += 1;
        };
        createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(setCount).toBe(0);
    });

    it('creates its own EventBus when none is provided', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.events).toBeInstanceOf(EventBus);
    });

    it('the bound resolver emits through the same bus', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        const before = captured.length;
        session.resolver.resolveClass('com.example.app.Foo');
        const after = captured.length;
        expect(after).toBeGreaterThan(before);
        const resolveEvt = captured.slice(before).find((e) => e.type === 'resolve');
        expect(resolveEvt).toBeDefined();
    });

    it('RosettaSession is a class instance', () => {
        const session = createSession({
            map: buildMap('1.2.3'),
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session).toBeInstanceOf(RosettaSession);
    });

    it('re-exports isRegistry from the session module', () => {
        expect(isRegistry(buildMap('1.2.3'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Signer-certificate enforcement (RFC 0001 Decision 3)
// ---------------------------------------------------------------------------

/** SHA-256 hex of some certificate bytes (masking signed Java bytes). */
function certHash(bytes: number[]): string {
    return createHash('sha256')
        .update(Buffer.from(bytes.map((b) => b & 0xff)))
        .digest('hex');
}

/**
 * Build a signer Java API exposing ActivityThread + MessageDigest with the
 * supplied certificate byte arrays as the live signers (via API 28+
 * signingInfo). `usePre28` routes through the legacy signatures field.
 */
function makeSignerJavaApi(certs: number[][], usePre28 = false): SignerJavaApi {
    const activityThread = {
        currentApplication: () => ({
            getApplicationContext: () => ({
                getPackageManager: () => ({
                    getPackageInfo: (_pkg: string, flags: number) => {
                        const sigs = certs.map((bytes) => ({ toByteArray: () => bytes }));
                        if (usePre28) {
                            // Modern flag yields nothing; legacy field carries them.
                            return flags === GET_SIGNING_CERTIFICATES
                                ? {}
                                : { signatures: { value: sigs } };
                        }
                        return {
                            signingInfo: { value: { getApkContentsSigners: () => sigs } },
                        };
                    },
                }),
            }),
            getPackageName: () => 'com.example.app',
        }),
    };
    const messageDigestClass = {
        getInstance: () => ({
            digest: (input: SignerByteArray): SignerByteArray => {
                const arr: number[] = [];
                for (let i = 0; i < input.length; i += 1) arr.push((input[i] ?? 0) & 0xff);
                const hex = createHash('sha256').update(Buffer.from(arr)).digest('hex');
                const out: number[] = [];
                for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
                return out;
            },
        }),
    };
    return {
        use: ((name: string) =>
            name === 'android.app.ActivityThread'
                ? activityThread
                : messageDigestClass) as SignerJavaApi['use'],
    };
}

/** A map that carries a signer_sha256 equal to the hash of `certs[0]`. */
function buildSignedMap(certs: number[][]): RosettaMap {
    return { ...buildMap('1.2.3'), signer_sha256: certHash(certs[0]) };
}

describe('createSession — signer enforcement', () => {
    const liveCerts = [[1, 2, 3, 4]];

    it('proceeds and emits a passing signer-check when a signer matches', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: buildSignedMap(liveCerts),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            signerJavaApi: makeSignerJavaApi(liveCerts),
        });
        expect(session.healthy).toBe(true);
        const sc = captured.find((e) => e.type === 'signer-check');
        expect(sc).toBeDefined();
        if (sc?.type === 'signer-check') {
            expect(sc.passed).toBe(true);
            expect(sc.app).toBe('com.example.app');
            expect(sc.source).toBe('signingInfo');
            expect(sc.expected).toBe(certHash(liveCerts[0]));
        }
    });

    it('throws SignerMismatchError and emits a failing event on mismatch', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const map: RosettaMap = { ...buildMap('1.2.3'), signer_sha256: 'a'.repeat(64) };
        expect(() =>
            createSession({
                map,
                app: 'com.example.app',
                version: '1.2.3',
                events,
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
                signerJavaApi: makeSignerJavaApi(liveCerts),
            }),
        ).toThrow(SignerMismatchError);
        const sc = captured.find((e) => e.type === 'signer-check');
        expect(sc).toBeDefined();
        if (sc?.type === 'signer-check') {
            expect(sc.passed).toBe(false);
            expect(sc.expected).toBe('a'.repeat(64));
            expect(sc.actual).toEqual([certHash(liveCerts[0])]);
        }
    });

    it('carries structured context on the thrown SignerMismatchError', () => {
        let caught: SignerMismatchError | undefined;
        try {
            createSession({
                map: { ...buildMap('1.2.3'), signer_sha256: 'b'.repeat(64) },
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
                signerJavaApi: makeSignerJavaApi(liveCerts),
            });
        } catch (e) {
            caught = e as SignerMismatchError;
        }
        expect(caught).toBeInstanceOf(SignerMismatchError);
        expect(caught?.app).toBe('com.example.app');
        expect(caught?.expected).toBe('b'.repeat(64));
        expect(caught?.actual).toEqual([certHash(liveCerts[0])]);
    });

    it('skips the check (no event) when the map has no signer_sha256', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: buildMap('1.2.3'), // no signer_sha256
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            // signerJavaApi intentionally omitted — must never be consulted.
        });
        expect(session.healthy).toBe(true);
        expect(captured.find((e) => e.type === 'signer-check')).toBeUndefined();
    });

    it('skips the check when enforceSigner is false even if signer_sha256 is set', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map: { ...buildMap('1.2.3'), signer_sha256: 'a'.repeat(64) },
            app: 'com.example.app',
            version: '1.2.3',
            enforceSigner: false,
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
        });
        expect(session.healthy).toBe(true);
        expect(captured.find((e) => e.type === 'signer-check')).toBeUndefined();
    });

    it('matches when ANY of multiple live signers matches the map', () => {
        const multi = [
            [9, 9, 9],
            [1, 2, 3, 4],
        ];
        // Map expects the SECOND signer's hash.
        const map: RosettaMap = { ...buildMap('1.2.3'), signer_sha256: certHash(multi[1]) };
        const session = createSession({
            map,
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            signerJavaApi: makeSignerJavaApi(multi),
        });
        expect(session.healthy).toBe(true);
    });

    it('reads signers via the pre-28 GET_SIGNATURES fallback path', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: buildSignedMap(liveCerts),
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
            signerJavaApi: makeSignerJavaApi(liveCerts, /* usePre28 */ true),
        });
        const sc = captured.find((e) => e.type === 'signer-check');
        expect(sc?.type === 'signer-check' && sc.source).toBe('signatures');
    });

    it('throws MissingSignerError when the live app exposes no readable signer', () => {
        let caught: MissingSignerError | undefined;
        try {
            createSession({
                map: { ...buildMap('1.2.3'), signer_sha256: 'c'.repeat(64) },
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
                // No signers present on the live app (empty signingInfo, no legacy).
                signerJavaApi: makeSignerJavaApi([]),
            });
        } catch (e) {
            caught = e as MissingSignerError;
        }
        expect(caught).toBeInstanceOf(MissingSignerError);
        expect(caught?.expected).toBe('c'.repeat(64));
    });

    it('throws MalformedSignerError when the MAP hash is ill-formed', () => {
        let caught: MalformedSignerError | undefined;
        try {
            createSession({
                map: { ...buildMap('1.2.3'), signer_sha256: 'not-a-real-hash' },
                app: 'com.example.app',
                version: '1.2.3',
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
                signerJavaApi: makeSignerJavaApi(liveCerts),
            });
        } catch (e) {
            caught = e as MalformedSignerError;
        }
        expect(caught).toBeInstanceOf(MalformedSignerError);
        expect(caught?.value).toBe('not-a-real-hash');
    });

    it('emits a deterministically SORTED actual list on a mismatch', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        // Three live signers; none matches the map's expected hash.
        const multi = [[3], [1], [2]];
        const sortedHashes = multi.map((c) => certHash(c)).sort();
        let caught: SignerMismatchError | undefined;
        try {
            createSession({
                map: { ...buildMap('1.2.3'), signer_sha256: 'a'.repeat(64) },
                app: 'com.example.app',
                version: '1.2.3',
                events,
                healthCheckJavaApi: makeHealthJavaApi(['aaaa', 'bbbb']),
                signerJavaApi: makeSignerJavaApi(multi),
            });
        } catch (e) {
            caught = e as SignerMismatchError;
        }
        expect(caught?.actual).toEqual(sortedHashes);
        const sc = captured.find((e) => e.type === 'signer-check');
        if (sc?.type === 'signer-check') {
            expect(sc.actual).toEqual(sortedHashes);
        }
    });
});

describe('createSession — health check honours the target-namespace guard', () => {
    /** A map whose single class points at a forbidden framework FQN. */
    function maliciousMap(): RosettaMap {
        return {
            schema_version: 4,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                'com.example.app.Evil': { obfuscated: 'java.lang.Runtime' },
            },
        };
    }

    it('does NOT call Java.use for a guard-denied entry at attach time', () => {
        const useSpy = vi.fn(() => ({}));
        // warn policy so a failed health check does not throw — we want to
        // inspect that the forbidden name never reached Java.use.
        const session = createSession({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '1.2.3',
            failurePolicy: 'warn',
            healthCheckJavaApi: { use: useSpy },
        });
        expect(useSpy).not.toHaveBeenCalled();
        // The denied entry is counted as a failed health-check entry.
        expect(session.healthy).toBe(false);
    });

    it('reports the guard-denied entry as a failed health-check entry', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        createSession({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '1.2.3',
            failurePolicy: 'warn',
            events,
            healthCheckJavaApi: { use: () => ({}) },
        });
        const hc = captured.find((e) => e.type === 'health-check');
        if (hc?.type === 'health-check') {
            expect(hc.passed).toBe(false);
            expect(hc.failedEntries).toEqual(['com.example.app.Evil']);
        } else {
            throw new Error('expected a health-check event');
        }
    });

    it('throws HealthCheckFailedError in strict mode for a guard-denied entry', () => {
        expect(() =>
            createSession({
                map: maliciousMap(),
                app: 'com.example.app',
                version: '1.2.3',
                failurePolicy: 'strict',
                healthCheckJavaApi: { use: () => ({}) },
            }),
        ).toThrow(HealthCheckFailedError);
    });
});
