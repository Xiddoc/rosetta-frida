/**
 * Tests for the instance proxy.
 *
 * Coverage targets:
 *   - $realName / $obfName / $native metadata.
 *   - Field access by real name returns a FieldAccessor; round-trip works.
 *   - Field access is memoized (=== identity).
 *   - Unknown field name throws via the Resolver.
 *   - Non-string property reads return undefined.
 */
import { describe, expect, it } from 'vitest';

import { MockFrida, useFridaMock, type JavaWrapper } from '../../tests/mocks/index.js';
import { ResolveError } from '../errors.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { makeInstanceProxy } from './instance-proxy.js';

const map: RosettaMap = {
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Klass': {
            obfuscated: 'aaaa',
            fields: {
                fieldA: { obfuscated: 'a', type: 'Ljava/lang/String;' },
                fieldB: { obfuscated: 'b', type: 'I' },
            },
        },
    },
};

function setup() {
    MockFrida.registerClass('aaaa', {
        fields: {
            a: { type: 'Ljava/lang/String;', initial: 'hello' },
            b: { type: 'I', initial: 1 },
        },
    });
    const resolver = createResolver(map);
    const wrapper = Java.use('aaaa') as JavaWrapper;
    const instance = wrapper.$new();
    return { resolver, instance };
}

describe('makeInstanceProxy', () => {
    useFridaMock();

    it('exposes $realName, $obfName, $native', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        expect(inst.$realName).toBe('com.example.app.Klass');
        expect(inst.$obfName).toBe('aaaa');
        expect(inst.$native).toBe(instance);
    });

    it('returns a FieldAccessor for a known field and round-trips values', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        const accessor = inst.fieldA as { value: string };
        expect(accessor.value).toBe('hello');
        accessor.value = 'world';
        expect(accessor.value).toBe('world');
    });

    it('memoizes field accessors per real name', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        const a = inst.fieldA;
        const b = inst.fieldA;
        expect(a).toBe(b);
    });

    it('throws ResolveError for an unknown field name', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        expect(() => inst.nonexistent).toThrow(ResolveError);
    });

    it('non-string property reads return undefined', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        const sym = Symbol('x');
        expect((inst as unknown as Record<symbol, unknown>)[sym]).toBeUndefined();
    });

    it('drops a stale field accessor after a tier-3 override', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        // Cache the accessor for fieldA → obf 'a' ('hello').
        const before = inst.fieldA as { value: string };
        expect(before.value).toBe('hello');

        // Override so fieldA now maps to obf 'b' (an int field on the
        // same instance, initial 1).
        resolver.override('com.example.app.Klass', {
            obfuscated: 'aaaa',
            fields: { fieldA: { obfuscated: 'b', type: 'I' } },
        });

        const after = inst.fieldA as { value: number };
        expect(after).not.toBe(before);
        expect(after.value).toBe(1);
    });

    it('reflects the overridden $obfName on a live instance proxy', () => {
        const { resolver, instance } = setup();
        const inst = makeInstanceProxy(resolver, 'com.example.app.Klass', instance);
        expect(inst.$obfName).toBe('aaaa');
        resolver.override('com.example.app.Klass', { obfuscated: 'cccc' });
        expect(inst.$obfName).toBe('cccc');
    });
});
