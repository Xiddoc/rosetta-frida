/**
 * Tests for the attach-time health-check helper. Uses the Frida mock
 * to drive Java.use, and also exercises the explicit javaApi-injection
 * path directly for failure / empty cases.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { MockFrida, installFridaMock, resetFridaMock } from '../../tests/mocks/frida.js';
import { javaBridgeFromUse } from '../java-bridge.js';
import type { RosettaMap } from '../types/map.js';
import {
    runHealthCheck,
    DEFAULT_HEALTH_CHECK_THRESHOLD,
    type HealthCheckJavaApi,
} from './health-check.js';

function buildMap(classes: RosettaMap['classes']): RosettaMap {
    return {
        schema_version: 3,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes,
    };
}

describe('runHealthCheck', () => {
    afterEach(() => {
        resetFridaMock();
    });

    it('returns passed=true when every class resolves', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', {});
        MockFrida.registerClass('bbbb', {});
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        });
        const result = runHealthCheck({ map });
        expect(result.passed).toBe(true);
        expect(result.rate).toBe(1);
        expect(result.failedEntries).toEqual([]);
        expect(result.total).toBe(2);
        expect(result.threshold).toBe(DEFAULT_HEALTH_CHECK_THRESHOLD);
    });

    it('marks classes whose Java.use fails as failures', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', {});
        // 'bbbb' deliberately not registered → Java.use throws.
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        });
        const result = runHealthCheck({ map, threshold: 0.6 });
        expect(result.rate).toBe(0.5);
        expect(result.failedEntries).toEqual(['com.example.app.Bar']);
        expect(result.passed).toBe(false);
    });

    it('verifies AIDL descriptor when the map specifies one', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', { aidlDescriptor: 'com.example.IFoo' });
        MockFrida.registerClass('bbbb', { aidlDescriptor: 'com.example.WrongDescriptor' });
        const map = buildMap({
            'com.example.app.IFooStub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
                aidl_descriptor: 'com.example.IFoo',
            },
            'com.example.app.IBarStub': {
                obfuscated: 'bbbb',
                kind: 'aidl_stub',
                aidl_descriptor: 'com.example.IBar',
            },
        });
        const result = runHealthCheck({ map, threshold: 0.99 });
        expect(result.failedEntries).toEqual(['com.example.app.IBarStub']);
        expect(result.passed).toBe(false);
    });

    it('verifies anchor strings when the map specifies them', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', {
            anchorStrings: ['must-have', 'optional-extra'],
        });
        MockFrida.registerClass('bbbb', { anchorStrings: ['something-else'] });
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa', anchors: ['must-have'] },
            'com.example.app.Bar': { obfuscated: 'bbbb', anchors: ['must-have'] },
        });
        const result = runHealthCheck({ map, threshold: 0.99 });
        expect(result.failedEntries).toEqual(['com.example.app.Bar']);
    });

    it('passes when anchors are an empty array (no constraints)', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', { anchorStrings: [] });
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa', anchors: [] },
        });
        const result = runHealthCheck({ map });
        expect(result.passed).toBe(true);
        expect(result.rate).toBe(1);
    });

    it('respects an explicit threshold below the rate', () => {
        installFridaMock();
        MockFrida.registerClass('aaaa', {});
        // Only 1/2 will resolve.
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa' },
            'com.example.app.Bar': { obfuscated: 'missing' },
        });
        const result = runHealthCheck({ map, threshold: 0.5 });
        expect(result.passed).toBe(true);
        expect(result.rate).toBe(0.5);
    });

    it('returns trivially-passing result for an empty map', () => {
        installFridaMock();
        const result = runHealthCheck({ map: buildMap({}) });
        expect(result.passed).toBe(true);
        expect(result.rate).toBe(1);
        expect(result.failedEntries).toEqual([]);
        expect(result.total).toBe(0);
    });

    it('returns all failures when no Java runtime is available and the map is non-empty', () => {
        // No installFridaMock — global Java is undefined.
        const result = runHealthCheck({
            map: buildMap({
                'com.example.app.Foo': { obfuscated: 'aaaa' },
                'com.example.app.Bar': { obfuscated: 'bbbb' },
            }),
        });
        expect(result.passed).toBe(false);
        expect(result.rate).toBe(0);
        expect(result.failedEntries).toEqual(['com.example.app.Foo', 'com.example.app.Bar']);
        expect(result.total).toBe(2);
    });

    it('resolves classes through an injected JavaBridge', () => {
        // No global Java; drive verification entirely off the bridge seam.
        const seen: string[] = [];
        const bridge = javaBridgeFromUse((obfName: string) => {
            seen.push(obfName);
            return {};
        });
        const result = runHealthCheck({
            map: buildMap({ 'com.example.app.Foo': { obfuscated: 'aaaa' } }),
            bridge,
        });
        expect(result.passed).toBe(true);
        expect(seen).toEqual(['aaaa']);
    });

    it('treats an unavailable injected bridge as no runtime (all fail)', () => {
        const result = runHealthCheck({
            map: buildMap({ 'com.example.app.Foo': { obfuscated: 'aaaa' } }),
            bridge: javaBridgeFromUse(undefined),
        });
        expect(result.passed).toBe(false);
        expect(result.failedEntries).toEqual(['com.example.app.Foo']);
    });

    it('still returns passed for an empty map without a Java runtime', () => {
        // No installFridaMock.
        const result = runHealthCheck({ map: buildMap({}) });
        expect(result.passed).toBe(true);
        expect(result.rate).toBe(1);
        expect(result.failedEntries).toEqual([]);
        expect(result.total).toBe(0);
    });

    it('accepts an injected Java API', () => {
        const javaApi: HealthCheckJavaApi = {
            use: (name) => {
                if (name === 'aaaa') return { $aidlDescriptor: 'com.example.IFoo' };
                throw new Error('not registered: ' + name);
            },
        };
        const map = buildMap({
            'com.example.app.Foo': {
                obfuscated: 'aaaa',
                aidl_descriptor: 'com.example.IFoo',
            },
            'com.example.app.Bar': { obfuscated: 'bbbb' },
        });
        const result = runHealthCheck({ map, javaApi, threshold: 0.5 });
        expect(result.passed).toBe(true);
        expect(result.failedEntries).toEqual(['com.example.app.Bar']);
    });

    it('treats a null $aidlDescriptor as a mismatch when expected', () => {
        const javaApi: HealthCheckJavaApi = {
            use: () => ({ $aidlDescriptor: null }),
        };
        const map = buildMap({
            'com.example.app.Foo': {
                obfuscated: 'aaaa',
                aidl_descriptor: 'com.example.IFoo',
            },
        });
        const result = runHealthCheck({ map, javaApi });
        expect(result.passed).toBe(false);
        expect(result.failedEntries).toEqual(['com.example.app.Foo']);
    });

    it('handles missing $anchorStrings on the wrapper gracefully', () => {
        // Wrapper without $anchorStrings → treated as empty.
        const javaApi: HealthCheckJavaApi = {
            use: () => ({}),
        };
        const map = buildMap({
            'com.example.app.Foo': { obfuscated: 'aaaa', anchors: ['marker'] },
        });
        const result = runHealthCheck({ map, javaApi });
        expect(result.failedEntries).toEqual(['com.example.app.Foo']);
    });

    it('does NOT call Java.use for a guard-denied obfuscated name', () => {
        // A malicious/wrong map points a class at a framework FQN. The guard
        // must reject it BEFORE Java.use, so the framework class is never
        // loaded / <clinit>-initialized at attach.
        const useSpy = vi.fn(() => ({}));
        const javaApi: HealthCheckJavaApi = { use: useSpy };
        const map = buildMap({
            'com.example.app.Evil': { obfuscated: 'java.lang.Runtime' },
        });
        const result = runHealthCheck({ map, javaApi, appPrefix: 'com.example' });
        // The denied name was never handed to Frida.
        expect(useSpy).not.toHaveBeenCalled();
        // And it is reported as a failed entry.
        expect(result.failedEntries).toEqual(['com.example.app.Evil']);
        expect(result.passed).toBe(false);
        expect(result.rate).toBe(0);
    });

    it('guards each entry independently: allowed names still resolve', () => {
        const useSpy = vi.fn((name: string) => {
            if (name === 'aaaa') return {};
            throw new Error('should not be called for denied names: ' + name);
        });
        const javaApi: HealthCheckJavaApi = { use: useSpy };
        const map = buildMap({
            'com.example.app.Good': { obfuscated: 'aaaa' },
            'com.example.app.Evil': { obfuscated: 'android.app.ActivityThread' },
        });
        const result = runHealthCheck({
            map,
            javaApi,
            appPrefix: 'com.example',
            threshold: 0.5,
        });
        // The denied entry never reached Java.use; only the allowed one did.
        expect(useSpy).toHaveBeenCalledTimes(1);
        expect(useSpy).toHaveBeenCalledWith('aaaa');
        expect(result.failedEntries).toEqual(['com.example.app.Evil']);
        expect(result.rate).toBe(0.5);
        expect(result.passed).toBe(true);
    });
});
