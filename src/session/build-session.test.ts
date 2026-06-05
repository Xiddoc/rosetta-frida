/**
 * Unit tests for the individual `buildSession` pipeline stages. The
 * end-to-end behaviour is covered by `session.test.ts`; these tests pin
 * each stage's contract in isolation (value-or-typed-error) so a regression
 * is localised.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
    HealthCheckFailedError,
    MapVersionMismatchError,
    MissingSignerError,
    SignerMismatchError,
} from '../errors.js';
import { EventBus } from '../log.js';
import type { DiagnosticEvent } from '../types/events.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import type { AutoDetectJavaApi } from './auto-detect.js';
import {
    detectStage,
    healthStage,
    isVersionAcceptable,
    resolverStage,
    runSignerGuard,
    selectAndVerifyStage,
    type ResolvedDetection,
} from './build-session.js';
import type { HealthCheckJavaApi } from './health-check.js';
import type { SignerByteArray, SignerJavaApi } from './signer-detect.js';
import type { InternalSessionOptions } from './session.js';

function buildMap(version = '1.2.3', app = 'com.example.app', versionCode = 1): RosettaMap {
    return {
        schema_version: 2,
        version_code: versionCode,
        app,
        version,
        classes: {
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        },
    };
}

function autoDetectApi(app: string, version: string, versionCode?: number): AutoDetectJavaApi {
    return {
        use: () => ({
            currentApplication: () => ({
                getApplicationContext: () => ({
                    getPackageManager: () => ({
                        getPackageInfo: () => {
                            const info: {
                                versionName: { value: string };
                                getLongVersionCode?: () => number;
                            } = { versionName: { value: version } };
                            if (versionCode !== undefined) {
                                info.getLongVersionCode = () => versionCode;
                            }
                            return info;
                        },
                    }),
                }),
                getPackageName: () => app,
            }),
        }),
    };
}

function collect(): { events: EventBus; seen: DiagnosticEvent[] } {
    const events = new EventBus();
    const seen: DiagnosticEvent[] = [];
    events.on((e) => seen.push(e));
    return { events, seen };
}

describe('detectStage', () => {
    it('uses explicit app + version without auto-detecting', () => {
        const result = detectStage({
            map: buildMap(),
            app: 'com.example.app',
            version: '9.9.9',
            versionCode: 42,
        });
        expect(result).toEqual({
            app: 'com.example.app',
            version: '9.9.9',
            versionCode: 42,
            source: 'override',
        });
    });

    it('auto-detects when app/version are omitted', () => {
        const result = detectStage({
            map: buildMap(),
            autoDetectJavaApi: autoDetectApi('com.example.app', '3.4.5', 30405),
        });
        expect(result).toEqual({
            app: 'com.example.app',
            version: '3.4.5',
            versionCode: 30405,
            source: 'auto',
        });
    });

    it('marks the source override when only one field is supplied', () => {
        const result = detectStage({
            map: buildMap(),
            version: '1.0.0',
            autoDetectJavaApi: autoDetectApi('com.example.app', 'ignored'),
        });
        expect(result.source).toBe('override');
        expect(result.version).toBe('1.0.0');
    });
});

describe('isVersionAcceptable', () => {
    it('accepts a matching version code (authoritative)', () => {
        expect(isVersionAcceptable(5, '1.0.0', 5, '1.0.0', false)).toBe(true);
    });
    it('rejects a mismatched version code unless fuzzy', () => {
        expect(isVersionAcceptable(5, '1.0.0', 6, '1.0.0', false)).toBe(false);
        expect(isVersionAcceptable(5, '1.0.0', 6, '1.0.0', true)).toBe(true);
    });
    it('falls back to label equality when no code was detected', () => {
        expect(isVersionAcceptable(5, '1.0.0', undefined, '1.0.0', false)).toBe(true);
        expect(isVersionAcceptable(5, '2.0.0', undefined, '1.0.0', false)).toBe(false);
    });
});

describe('selectAndVerifyStage', () => {
    const detection: ResolvedDetection = {
        app: 'com.example.app',
        version: '1.2.3',
        versionCode: 1,
        source: 'auto',
    };

    it('returns the picked map on a match', () => {
        const result = selectAndVerifyStage({ map: buildMap() }, detection, 'exact');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.version).toBe('1.2.3');
    });

    it('returns a MapVersionMismatchError on an app mismatch', () => {
        const result = selectAndVerifyStage(
            { map: buildMap('1.2.3', 'com.other.app') },
            detection,
            'exact',
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(MapVersionMismatchError);
    });

    it('returns a MapVersionMismatchError on a version-code mismatch', () => {
        const result = selectAndVerifyStage(
            { map: buildMap('1.2.3', 'com.example.app', 999) },
            detection,
            'exact',
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(MapVersionMismatchError);
    });

    it('selects by version_code from a registry', () => {
        const registry: RosettaMapRegistry = {
            '1.0.0': buildMap('1.0.0', 'com.example.app', 1),
            '2.0.0': buildMap('2.0.0', 'com.example.app', 2),
        };
        const result = selectAndVerifyStage(
            { map: registry },
            { app: 'com.example.app', version: '2.0.0', versionCode: 2, source: 'auto' },
            'exact',
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.version_code).toBe(2);
    });
});

describe('runSignerGuard', () => {
    function sha256Hex(bytes: number[]): string {
        return createHash('sha256')
            .update(Buffer.from(bytes.map((b) => b & 0xff)))
            .digest('hex');
    }

    function signerApi(certs: number[][]): SignerJavaApi {
        return {
            use: ((name: string) => {
                if (name === 'java.security.MessageDigest') {
                    return {
                        getInstance: () => ({
                            digest: (input: SignerByteArray) =>
                                createHash('sha256')
                                    .update(
                                        Buffer.from(
                                            Array.prototype.slice
                                                .call(input)
                                                .map((b: number) => b & 0xff),
                                        ),
                                    )
                                    .digest(),
                        }),
                    };
                }
                return {
                    currentApplication: () => ({
                        getApplicationContext: () => ({
                            getPackageManager: () => ({
                                getPackageInfo: () => ({
                                    signingInfo: {
                                        value: {
                                            getApkContentsSigners: () =>
                                                certs.map((c) => ({ toByteArray: () => c })),
                                        },
                                    },
                                }),
                            }),
                        }),
                        getPackageName: () => 'com.example.app',
                    }),
                };
            }) as SignerJavaApi['use'],
        };
    }

    it('is a no-op when the map has no signer hash', () => {
        const { events, seen } = collect();
        const result = runSignerGuard(buildMap(), 'com.example.app', { map: buildMap() }, events);
        expect(result.ok).toBe(true);
        expect(seen).toHaveLength(0);
    });

    it('is a no-op when enforceSigner is false', () => {
        const { events, seen } = collect();
        const map = { ...buildMap(), signer_sha256: 'a'.repeat(64) };
        const result = runSignerGuard(
            map,
            'com.example.app',
            { map, enforceSigner: false },
            events,
        );
        expect(result.ok).toBe(true);
        expect(seen).toHaveLength(0);
    });

    it('passes + emits when a live signer matches', () => {
        const certs = [[1, 2, 3, 4]];
        const map = { ...buildMap(), signer_sha256: sha256Hex(certs[0] as number[]) };
        const { events, seen } = collect();
        const result = runSignerGuard(
            map,
            'com.example.app',
            { map, signerJavaApi: signerApi(certs) },
            events,
        );
        expect(result.ok).toBe(true);
        expect(seen.some((e) => e.type === 'signer-check' && e.passed)).toBe(true);
    });

    it('returns SignerMismatchError when no live signer matches', () => {
        const map = { ...buildMap(), signer_sha256: 'b'.repeat(64) };
        const result = runSignerGuard(
            map,
            'com.example.app',
            { map, signerJavaApi: signerApi([[9, 9, 9]]) },
            new EventBus(),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(SignerMismatchError);
    });

    it('returns MissingSignerError when the app exposes no readable signer', () => {
        const map = { ...buildMap(), signer_sha256: 'c'.repeat(64) };
        const noSignerApi: SignerJavaApi = {
            use: ((name: string) => {
                if (name === 'java.security.MessageDigest') {
                    return { getInstance: () => ({ digest: () => Buffer.from([]) }) };
                }
                return {
                    currentApplication: () => ({
                        getApplicationContext: () => ({
                            getPackageManager: () => ({
                                getPackageInfo: () => ({ signingInfo: { value: null } }),
                            }),
                        }),
                        getPackageName: () => 'com.example.app',
                    }),
                };
            }) as SignerJavaApi['use'],
        };
        const result = runSignerGuard(
            map,
            'com.example.app',
            { map, signerJavaApi: noSignerApi },
            new EventBus(),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(MissingSignerError);
    });
});

describe('healthStage', () => {
    function healthApi(known: Set<string>): HealthCheckJavaApi {
        return {
            use: (obfName: string) => {
                if (!known.has(obfName)) throw new Error(`not loaded: ${obfName}`);
                return {};
            },
        };
    }

    it('skips the check when skipHealthCheck is set', () => {
        const { events, seen } = collect();
        const result = healthStage(
            buildMap(),
            'com.example.app',
            {
                map: buildMap(),
                skipHealthCheck: true,
            },
            'warn',
            events,
        );
        expect(result).toEqual({ ok: true, value: true });
        expect(seen).toHaveLength(0);
    });

    it('passes + emits when all classes resolve', () => {
        const { events, seen } = collect();
        const result = healthStage(
            buildMap(),
            'com.example.app',
            { map: buildMap(), healthCheckJavaApi: healthApi(new Set(['aaaa', 'bbbb'])) },
            'warn',
            events,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(true);
        expect(seen.some((e) => e.type === 'health-check' && e.passed)).toBe(true);
    });

    it('returns HealthCheckFailedError under strict when the check fails', () => {
        const result = healthStage(
            buildMap(),
            'com.example.app',
            { map: buildMap(), healthCheckJavaApi: healthApi(new Set()) },
            'strict',
            new EventBus(),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(HealthCheckFailedError);
    });

    it('reports unhealthy (no throw) under warn when the check fails', () => {
        const result = healthStage(
            buildMap(),
            'com.example.app',
            { map: buildMap(), healthCheckJavaApi: healthApi(new Set()) },
            'warn',
            new EventBus(),
        );
        expect(result).toEqual({ ok: true, value: false });
    });
});

describe('resolverStage', () => {
    it('builds a resolver bound to the given policy + bus', () => {
        const events = new EventBus();
        const options: InternalSessionOptions = { map: buildMap() };
        const resolver = resolverStage(buildMap(), 'com.example.app', options, 'warn', events);
        expect(resolver.failurePolicy).toBe('warn');
        expect(resolver.resolveClass('com.example.app.Foo').obfName).toBe('aaaa');
    });
});
