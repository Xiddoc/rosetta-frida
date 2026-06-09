/**
 * Tests for the Tier 3 `rosetta.map.*` surface (createMapApi).
 *
 * The surface is a thin delegating wrapper — exercise each delegated
 * method against a real session and verify the result.
 */

import { describe, it, expect } from 'vitest';
import { ResolveError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { createSession } from '../session/session.js';
import type { HealthCheckJavaApi } from '../session/health-check.js';
import { validateMap } from '../validate/schema.js';
import { createMapApi } from './map.js';

function buildMap(): RosettaMap {
    return validateMap({
        schema_version: 3,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {
            'com.example.app.Foo': {
                obfuscated: 'aaaa',
                methods: {
                    bar: { obfuscated: 'c', signature: '()V' },
                },
                fields: {
                    state: { obfuscated: 'f', type: 'Ljava/lang/String;' },
                },
            },
        },
    });
}

function makeHealthJavaApi(): HealthCheckJavaApi {
    return {
        use: (name) =>
            name === 'aaaa'
                ? {}
                : (() => {
                      throw new Error(name);
                  })(),
    };
}

function makeSession() {
    return createSession({
        map: buildMap(),
        app: 'com.example.app',
        version: '1.2.3',
        failurePolicy: 'strict',
        healthCheckJavaApi: makeHealthJavaApi(),
    });
}

function makeWarnSession() {
    return createSession({
        map: buildMap(),
        app: 'com.example.app',
        version: '1.2.3',
        failurePolicy: 'warn',
        healthCheckJavaApi: makeHealthJavaApi(),
    });
}

describe('createMapApi', () => {
    it('resolveClass delegates to the session resolver', () => {
        const session = makeSession();
        const api = createMapApi(session);
        const result = api.resolveClass('com.example.app.Foo');
        expect(result.obfName).toBe('aaaa');
        expect(result.realName).toBe('com.example.app.Foo');
    });

    it('resolveClass throws on miss (under strict policy)', () => {
        const session = makeSession();
        const api = createMapApi(session);
        expect(() => api.resolveClass('com.example.app.Missing')).toThrow(ResolveError);
    });

    it('resolveClass throws on miss even under warn policy (tier-3 is always strict)', () => {
        // Tier-3 `map.resolve*` are explicit resolution REQUESTS: they throw
        // on a miss regardless of the session failurePolicy, unlike the
        // deferred-sentinel behaviour of tier-1/2 reads under `warn`.
        const session = makeWarnSession();
        const api = createMapApi(session);
        expect(() => api.resolveClass('com.example.app.Missing')).toThrow(ResolveError);
    });

    it('resolveMethod delegates with argTypes', () => {
        const session = makeSession();
        const api = createMapApi(session);
        const result = api.resolveMethod('com.example.app.Foo', 'bar');
        expect(result.obfName).toBe('c');
        expect(result.signature).toBe('()V');
    });

    it('resolveMethod accepts an explicit argTypes', () => {
        const session = makeSession();
        const api = createMapApi(session);
        const result = api.resolveMethod('com.example.app.Foo', 'bar', []);
        expect(result.obfName).toBe('c');
    });

    it('resolveField delegates', () => {
        const session = makeSession();
        const api = createMapApi(session);
        const result = api.resolveField('com.example.app.Foo', 'state');
        expect(result.obfName).toBe('f');
    });

    it('override installs a runtime override visible to future resolves', () => {
        const session = makeSession();
        const api = createMapApi(session);
        api.override('com.example.app.Foo', { obfuscated: 'zzzz' });
        const result = api.resolveClass('com.example.app.Foo');
        expect(result.obfName).toBe('zzzz');
    });

    it('extract returns the bound RosettaMap', () => {
        const session = makeSession();
        const api = createMapApi(session);
        expect(api.extract()).toBe(session.map);
        expect(api.extract().app).toBe('com.example.app');
    });
});
