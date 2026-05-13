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
 *   - AIDL descriptor + anchor verification in the health check.
 *   - trace mode propagates to the bus.
 *   - Resolver is wired to the session bus.
 */

import { describe, it, expect } from 'vitest';
import { HealthCheckFailedError, MapVersionMismatchError } from '../errors.js';
import { EventBus } from '../log.js';
import type { DiagnosticEvent } from '../types/events.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { createSession, RosettaSession, isRegistry } from './session.js';
import type { AutoDetectJavaApi } from './auto-detect.js';
import type { HealthCheckJavaApi } from './health-check.js';

function buildMap(version: string, app = 'com.example.app'): RosettaMap {
    return {
        schema_version: 1,
        app,
        version,
        classes: {
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        },
    };
}

function makeAutoDetectJavaApi(app: string, version: string): AutoDetectJavaApi {
    return {
        use: () => ({
            currentApplication: () => ({
                getApplicationContext: () => ({
                    getPackageManager: () => ({
                        getPackageInfo: () => ({ versionName: { value: version } }),
                    }),
                }),
                getPackageName: () => app,
            }),
        }),
    };
}

/** Helper: build a health-check Java api that resolves a given set of obf names. */
function makeHealthJavaApi(
    knownObfNames: Iterable<string>,
    extras: Record<
        string,
        { $aidlDescriptor?: string | null; $anchorStrings?: readonly string[] }
    > = {},
): HealthCheckJavaApi {
    const known = new Set(knownObfNames);
    return {
        use: (name) => {
            if (extras[name] !== undefined) return extras[name];
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
            expect(mapLoad.schemaVersion).toBe(1);
        }
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

describe('createSession — health check with AIDL descriptors and anchors', () => {
    const map: RosettaMap = {
        schema_version: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {
            'com.example.app.IFooStub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
                aidl_descriptor: 'com.example.IFoo',
            },
            'com.example.app.WithAnchor': {
                obfuscated: 'bbbb',
                anchors: ['marker-string'],
            },
        },
    };

    it('passes when aidl_descriptor matches', () => {
        const session = createSession({
            map,
            app: 'com.example.app',
            version: '1.2.3',
            healthCheckJavaApi: makeHealthJavaApi(['bbbb'], {
                aaaa: { $aidlDescriptor: 'com.example.IFoo' },
                bbbb: { $anchorStrings: ['marker-string'] },
            }),
        });
        expect(session.healthy).toBe(true);
    });

    it('fails when aidl_descriptor differs', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map,
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi(['bbbb'], {
                aaaa: { $aidlDescriptor: 'wrong-descriptor' },
                bbbb: { $anchorStrings: ['marker-string'] },
            }),
        });
        expect(session.healthy).toBe(false);
        const hc = captured.find((e) => e.type === 'health-check');
        if (hc?.type === 'health-check') {
            expect(hc.failedEntries).toContain('com.example.app.IFooStub');
        }
    });

    it('fails when anchor string is missing', () => {
        const events = new EventBus();
        const captured = captureEvents(events);
        const session = createSession({
            map,
            app: 'com.example.app',
            version: '1.2.3',
            events,
            healthCheckJavaApi: makeHealthJavaApi([], {
                aaaa: { $aidlDescriptor: 'com.example.IFoo' },
                bbbb: { $anchorStrings: ['other-string'] },
            }),
        });
        expect(session.healthy).toBe(false);
        const hc = captured.find((e) => e.type === 'health-check');
        if (hc?.type === 'health-check') {
            expect(hc.failedEntries).toContain('com.example.app.WithAnchor');
        }
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
