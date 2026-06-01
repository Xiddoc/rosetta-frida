/**
 * Tests for `field(...)` / `setField(...)` — tier-1 field access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResolveError, RosettaError } from '../errors.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import { field, setField } from './field.js';
import {
    MockFrida,
    installFridaMock,
    resetFridaMock,
    type JavaInstance,
    type JavaWrapper,
} from '../../tests/mocks/index.js';

function buildMap(): RosettaMap {
    return {
        schema_version: 2,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {
            'com.example.app.SomeClass': {
                obfuscated: 'aaaa',
                fields: {
                    sessionId: { obfuscated: 'a', type: 'Ljava/lang/String;' },
                    flags: { obfuscated: 'b', type: 'I' },
                },
            },
        },
    };
}

interface Harness {
    resolver: Resolver;
    wrapper: JavaWrapper;
    instance: JavaInstance;
}

function makeHarness(): Harness {
    const resolver = createResolver(buildMap());
    MockFrida.registerClass('aaaa', {
        fields: {
            a: { type: 'java.lang.String', initial: 'hello' },
            b: { type: 'I', initial: 42 },
        },
    });
    const wrapper = Java.use('aaaa');
    const instance = wrapper.$new();
    return { resolver, wrapper, instance };
}

beforeEach(() => {
    installFridaMock();
});
afterEach(() => {
    resetFridaMock();
});

describe('field', () => {
    it('reads a real-named field value', () => {
        const h = makeHarness();
        expect(field(h.instance, 'sessionId', { resolver: h.resolver })).toBe('hello');
        expect(field(h.instance, 'flags', { resolver: h.resolver })).toBe(42);
    });

    it('throws ResolveError on an unknown real field name', () => {
        const h = makeHarness();
        expect(() => field(h.instance, 'notAField', { resolver: h.resolver })).toThrow(
            ResolveError,
        );
    });

    it('throws ResolveError if the instance class is not in the loaded map', () => {
        const resolver = createResolver(buildMap());
        MockFrida.registerClass('unknownObf', {
            fields: { a: { type: 'I', initial: 0 } },
        });
        const inst = Java.use('unknownObf').$new();
        expect(() => field(inst, 'whatever', { resolver })).toThrow(ResolveError);
    });

    it('throws RosettaError if the instance argument is not an object', () => {
        const h = makeHarness();
        expect(() => field(null, 'sessionId', { resolver: h.resolver })).toThrow(RosettaError);
        expect(() => field('not an instance', 'sessionId', { resolver: h.resolver })).toThrow(
            RosettaError,
        );
    });

    it('falls back to instance.class.getName() when $className is absent', () => {
        const h = makeHarness();
        // Synthesize an instance-like shape exposing only class.getName(),
        // pretending to be the obfuscated class 'aaaa'. Frida's runtime
        // returns wrappers in this shape when called via Java.cast or
        // when crossing certain boundaries.
        const synthetic = {
            class: { getName: () => 'aaaa' },
            a: { value: 'fromFallback' },
            b: { value: 0 },
        };
        expect(field(synthetic, 'sessionId', { resolver: h.resolver })).toBe('fromFallback');
    });

    it('throws when neither $className nor class.getName is available', () => {
        const h = makeHarness();
        const noClass = { a: { value: 'x' } };
        expect(() => field(noClass, 'sessionId', { resolver: h.resolver })).toThrow(
            /cannot determine the instance class/,
        );
    });

    it('throws when the obfuscated field is not present on the instance', () => {
        const h = makeHarness();
        // Strip 'b' off the instance to simulate a partial wrapper.
        const partial = { $className: 'aaaa', a: { value: 'ok' } };
        expect(() => field(partial, 'flags', { resolver: h.resolver })).toThrow(
            /not present on the instance/,
        );
    });

    it('throws when the obfuscated property exists but lacks .value', () => {
        const h = makeHarness();
        const broken = { $className: 'aaaa', a: 'no-accessor' };
        expect(() => field(broken, 'sessionId', { resolver: h.resolver })).toThrow(
            /\.value accessor/,
        );
    });

    it('tolerates a resolver without reverseLookup (defensive branch)', () => {
        const h = makeHarness();
        // Wrap the resolver to hide reverseLookup, ensuring the field
        // helper degrades into a clear error rather than crashing.
        const wrapped = {
            resolveField: h.resolver.resolveField.bind(h.resolver),
        } as unknown as Resolver;
        expect(() => field(h.instance, 'sessionId', { resolver: wrapped })).toThrow(ResolveError);
    });
});

describe('setField', () => {
    it('writes a real-named field value', () => {
        const h = makeHarness();
        setField(h.instance, 'sessionId', 'new-id', { resolver: h.resolver });
        expect(field(h.instance, 'sessionId', { resolver: h.resolver })).toBe('new-id');
    });

    it('writes primitive values', () => {
        const h = makeHarness();
        setField(h.instance, 'flags', 99, { resolver: h.resolver });
        expect(field(h.instance, 'flags', { resolver: h.resolver })).toBe(99);
    });

    it('throws ResolveError on an unknown real field name', () => {
        const h = makeHarness();
        expect(() => setField(h.instance, 'notAField', 'x', { resolver: h.resolver })).toThrow(
            ResolveError,
        );
    });

    it('throws RosettaError if the instance argument is not an object', () => {
        const h = makeHarness();
        expect(() => setField(42, 'sessionId', 'x', { resolver: h.resolver })).toThrow(
            RosettaError,
        );
    });
});
