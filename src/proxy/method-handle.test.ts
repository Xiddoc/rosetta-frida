/**
 * Tests for the method-handle wrapper.
 *
 * Coverage targets:
 *   - `.overload(...realArgs)` translates real-name args; passes
 *     framework types and primitives through verbatim.
 *   - `.overloads` returns the native overloads array unchanged.
 *   - `.implementation` get/set delegates for single-overload methods.
 *   - `.implementation` get/set throws AmbiguousOverloadError when the
 *     map records multiple overloads for the same real method name.
 *   - `.$native` exposes the bare Frida method.
 *   - Defensive error when the underlying Frida method is missing
 *     (map/app disagreement).
 */
import { describe, expect, it } from 'vitest';

import { MockFrida, useFridaMock, type JavaWrapper } from '../../tests/mocks/index.js';
import { AmbiguousOverloadError } from '../errors.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { makeMethodHandle } from './method-handle.js';

// A map with both a single-overload method (`c`) and a multi-overload
// method (also key `c` in obfuscation — array form). The proxy looks
// only at the real-name side, so we name them `single` and `multi` at
// the real level.
const baseMap: RosettaMap = {
    schema_version: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Stub': {
            obfuscated: 'aaaa',
            methods: {
                single: {
                    obfuscated: 'c',
                    signature: '(Landroid/os/Bundle;Lbbbb;)V',
                },
                multi: [
                    { obfuscated: 'd', signature: '(Landroid/os/Bundle;)V' },
                    { obfuscated: 'd', signature: '(Ljava/lang/String;)V' },
                ],
            },
            fields: {},
        },
        'com.example.app.Callback': { obfuscated: 'bbbb' },
    },
};

describe('makeMethodHandle — overload translation', () => {
    useFridaMock();

    it('translates real-name class args through the resolver', () => {
        MockFrida.registerClass('bbbb', {});
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }, { className: 'bbbb' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'single', native, 'c');
        const picked = handle.overload('android.os.Bundle', 'com.example.app.Callback');
        // Result is the bare Frida overload — verify argumentTypes match.
        expect(picked.argumentTypes.map((a) => a.className)).toEqual(['android.os.Bundle', 'bbbb']);
    });

    it('passes Java primitives and unmapped types through verbatim', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
                    {
                        argumentTypes: [
                            { className: 'int' },
                            { className: 'boolean' },
                            { className: 'java.lang.String' },
                        ],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'single', native, 'c');
        const picked = handle.overload('int', 'boolean', 'java.lang.String');
        expect(picked.argumentTypes.map((a) => a.className)).toEqual([
            'int',
            'boolean',
            'java.lang.String',
        ]);
    });

    it('.overloads returns the native overloads array', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                d: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }],
                        returnType: { className: 'void' },
                    },
                    {
                        argumentTypes: [{ className: 'java.lang.String' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'multi', native, 'd');
        const overloads = handle.overloads;
        expect(overloads).toHaveLength(2);
        expect(overloads[0]?.argumentTypes[0]?.className).toBe('android.os.Bundle');
    });

    it('.$native exposes the bare Frida method object', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'single', native, 'c');
        const bare = handle.$native as { overloads: unknown[] };
        expect(bare.overloads).toHaveLength(1);
    });
});

describe('makeMethodHandle — .implementation', () => {
    useFridaMock();

    it('reads and writes for a single-overload method', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'single', native, 'c');
        expect(handle.implementation).toBeNull();
        let received: unknown = null;
        handle.implementation = (b) => {
            received = b;
        };
        expect(handle.implementation).not.toBeNull();
        handle.implementation?.('payload');
        expect(received).toBe('payload');
    });

    it('throws AmbiguousOverloadError on get for a multi-overload real name', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                d: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }],
                        returnType: { className: 'void' },
                    },
                    {
                        argumentTypes: [{ className: 'java.lang.String' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'multi', native, 'd');
        expect(() => handle.implementation).toThrow(AmbiguousOverloadError);
        expect(() => {
            handle.implementation = () => null;
        }).toThrow(AmbiguousOverloadError);
    });
});

describe('makeMethodHandle — defensive native lookup', () => {
    useFridaMock();

    it('throws if the underlying method disappears (map/app disagreement)', () => {
        MockFrida.registerClass('aaaa', {});
        const resolver = createResolver(baseMap);
        const native = Java.use('aaaa') as JavaWrapper;
        const handle = makeMethodHandle(resolver, 'com.example.app.Stub', 'single', native, 'c');
        expect(() => handle.overload()).toThrow(/not present.*disagree/);
        expect(() => handle.overloads).toThrow(/not present.*disagree/);
        expect(() => handle.$native).toThrow(/not present.*disagree/);
        expect(() => handle.implementation).toThrow(/not present.*disagree/);
        expect(() => {
            handle.implementation = () => null;
        }).toThrow(/not present.*disagree/);
    });
});
