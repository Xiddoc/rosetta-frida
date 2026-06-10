/**
 * Tests for the field accessor wrapper.
 *
 * The accessor's surface is intentionally tiny — just `{ value: T }`
 * over an obfuscated-named field on a Frida wrapper / instance.
 * Coverage focuses on:
 *
 *   - round-trip get/set against the underlying Frida-side field
 *   - error path when the field is absent on the native side
 *     (defensive guard for map/app disagreement)
 *   - the symmetry-only `resolver` parameter doesn't break the wrapper
 */
import { describe, expect, it } from 'vitest';

import {
    MockFrida,
    useFridaMock,
    type JavaInstance,
    type JavaWrapper,
} from '../../tests/mocks/index.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { makeFieldAccessor } from './field-accessor.js';

const baseMap: RosettaMap = {
    schema_version: 4,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Klass': {
            obfuscated: 'aaaa',
            fields: {
                STATIC_F: { obfuscated: 'a', type: 'I', static: true },
                instanceF: { obfuscated: 'b', type: 'Ljava/lang/String;' },
            },
        },
    },
};

describe('makeFieldAccessor — static field', () => {
    useFridaMock();

    it('round-trips reads and writes against the underlying Frida field', () => {
        MockFrida.registerClass('aaaa', {
            fields: { a: { type: 'I', static: true, initial: 7 } },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const accessor = makeFieldAccessor<number>(
            resolver,
            'com.example.app.Klass',
            'STATIC_F',
            native,
            'a',
        );
        expect(accessor.value).toBe(7);
        accessor.value = 42;
        expect(accessor.value).toBe(42);
        // The change is also visible directly through the native shape.
        expect((native.a as { value: number }).value).toBe(42);
    });

    it('throws a descriptive error if the underlying field disappears', () => {
        MockFrida.registerClass('aaaa', {});
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const accessor = makeFieldAccessor<number>(
            resolver,
            'com.example.app.Klass',
            'STATIC_F',
            native,
            'a',
        );
        expect(() => accessor.value).toThrow(/not present.*map.*disagree/);
        expect(() => {
            accessor.value = 99;
        }).toThrow(/not present.*map.*disagree/);
    });
});

describe('makeFieldAccessor — instance field', () => {
    useFridaMock();

    it('round-trips reads and writes against a Java instance', () => {
        MockFrida.registerClass('aaaa', {
            fields: { b: { type: 'Ljava/lang/String;', initial: 'hello' } },
        });
        const resolver = createResolver(baseMap);
        const wrapper = Java.use('aaaa') as JavaWrapper;
        const instance: JavaInstance = wrapper.$new();
        const accessor = makeFieldAccessor<string>(
            resolver,
            'com.example.app.Klass',
            'instanceF',
            instance,
            'b',
        );
        expect(accessor.value).toBe('hello');
        accessor.value = 'world';
        expect(accessor.value).toBe('world');
    });
});
