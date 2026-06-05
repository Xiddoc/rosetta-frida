/**
 * Tests for the class proxy.
 *
 * Coverage targets:
 *   - Metadata accessors: $realName, $obfName, $native, $resolver, .class.
 *   - $new(...) constructs an instance and returns an InstanceProxy.
 *   - Member access for a known method returns a MethodHandle.
 *   - Member access for a known field returns a FieldAccessor.
 *   - Member access is memoized: same access twice → same object (===).
 *   - Unknown members throw ResolveError via the Resolver path.
 *   - The default `javaUse` falls back to global `Java` and errors
 *     cleanly when Java is absent.
 *   - Non-string property accesses (symbols, numbers) return undefined.
 */
import { describe, expect, it } from 'vitest';

import { MockFrida, useFridaMock } from '../../tests/mocks/index.js';
import { ResolveError } from '../errors.js';
import { javaBridgeFromUse } from '../java-bridge.js';
import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { makeClassProxy } from './class-proxy.js';

const map: RosettaMap = {
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Stub': {
            obfuscated: 'aaaa',
            methods: {
                requestTicket: {
                    obfuscated: 'c',
                    signature: '(Landroid/os/Bundle;Lbbbb;)V',
                },
                multi: [
                    { obfuscated: 'd', signature: '(Landroid/os/Bundle;)V' },
                    { obfuscated: 'd', signature: '(Ljava/lang/String;)V' },
                ],
            },
            fields: {
                STATIC_F: { obfuscated: 's', type: 'I', static: true },
                instanceF: { obfuscated: 'i', type: 'Ljava/lang/String;' },
            },
        },
        'com.example.app.Callback': { obfuscated: 'bbbb' },
    },
};

function registerStub(): void {
    MockFrida.registerClass('bbbb', {});
    MockFrida.registerClass('aaaa', {
        methods: {
            c: [
                {
                    argumentTypes: [{ className: 'android.os.Bundle' }, { className: 'bbbb' }],
                    returnType: { className: 'void' },
                },
            ],
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
        fields: {
            s: { type: 'I', static: true, initial: 42 },
            i: { type: 'Ljava/lang/String;', initial: 'hello' },
        },
    });
}

describe('makeClassProxy — metadata', () => {
    useFridaMock();

    it('exposes $realName, $obfName, $native, $resolver', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        expect(Stub.$realName).toBe('com.example.app.Stub');
        expect(Stub.$obfName).toBe('aaaa');
        expect(Stub.$resolver).toBe(resolver);
        expect((Stub.$native as { $className: string }).$className).toBe('aaaa');
    });

    it('.class passes through to the underlying Java class object', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const Klass = Stub.class as { getName: () => string };
        expect(Klass.getName()).toBe('aaaa');
    });

    it('non-string property reads return undefined', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const sym = Symbol('x');
        // Cast through unknown for indexing with a symbol.
        const value = (Stub as unknown as Record<symbol, unknown>)[sym];
        expect(value).toBeUndefined();
    });
});

describe('makeClassProxy — $new', () => {
    useFridaMock();

    it('constructs an instance and wraps it in an InstanceProxy', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const inst = Stub.$new() as { $realName: string; $obfName: string; instanceF: unknown };
        expect(inst.$realName).toBe('com.example.app.Stub');
        expect(inst.$obfName).toBe('aaaa');
        const accessor = inst.instanceF as { value: string };
        expect(accessor.value).toBe('hello');
        accessor.value = 'world';
        expect(accessor.value).toBe('world');
    });
});

describe('makeClassProxy — method access', () => {
    useFridaMock();

    it('returns a MethodHandle for a known real method name', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const handle = Stub.requestTicket as { overload: (...a: string[]) => unknown };
        const picked = handle.overload('android.os.Bundle', 'com.example.app.Callback') as {
            argumentTypes: { className: string }[];
        };
        expect(picked.argumentTypes.map((a) => a.className)).toEqual(['android.os.Bundle', 'bbbb']);
    });

    it('memoizes method handles per real name (=== identity)', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const a = Stub.requestTicket;
        const b = Stub.requestTicket;
        expect(a).toBe(b);
    });

    it('returns a MethodHandle for a multi-overload real name (deferring ambiguity to .implementation)', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        // The access itself must succeed.
        const handle = Stub.multi as { overload: (...a: string[]) => unknown };
        const picked = handle.overload('android.os.Bundle') as {
            argumentTypes: { className: string }[];
        };
        expect(picked.argumentTypes[0]?.className).toBe('android.os.Bundle');
    });
});

describe('makeClassProxy — field access', () => {
    useFridaMock();

    it('returns a FieldAccessor for a known static field', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const f = Stub.STATIC_F as { value: number };
        expect(f.value).toBe(42);
        f.value = 99;
        expect(f.value).toBe(99);
    });

    it('memoizes field accessors per real name', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        const a = Stub.STATIC_F;
        const b = Stub.STATIC_F;
        expect(a).toBe(b);
    });
});

describe('makeClassProxy — unknown member', () => {
    useFridaMock();

    it('throws a ResolveError citing the class and member', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        expect(() => Stub.nonexistent).toThrow(ResolveError);
        try {
            void Stub.nonexistent;
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            expect((e as ResolveError).classScope).toBe('com.example.app.Stub');
            expect((e as ResolveError).realName).toBe('nonexistent');
        }
    });
});

describe('makeClassProxy — defaultJavaUse fallback', () => {
    useFridaMock();

    it('uses global Java.use by default when no javaUse option is given', () => {
        registerStub();
        const resolver = createResolver(map);
        // Don't pass options.javaUse — exercise the default code path.
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        expect(Stub.$obfName).toBe('aaaa');
    });

    it('throws a friendly error when global Java is absent', () => {
        // Wipe Java from globalThis just for this test scope, then restore.
        const g = globalThis as { Java?: unknown };
        const saved = g.Java;
        try {
            // Bypass the type by deleting through a wider cast.
            delete (g as Record<string, unknown>).Java;
            const resolver = createResolver(map);
            expect(() => makeClassProxy(resolver, 'com.example.app.Stub')).toThrow(
                /global 'Java' is not available/,
            );
        } finally {
            g.Java = saved;
        }
    });

    it('honours the javaUse option override (no global Java needed)', () => {
        const g = globalThis as { Java?: unknown };
        const saved = g.Java;
        try {
            delete (g as Record<string, unknown>).Java;
            // Set up the mock registration first; then re-install a custom javaUse.
            registerStubViaCustomRegistry();
            const resolver = createResolver(map);
            const customUse = (obf: string): unknown => customRegistry.get(obf);
            const Stub = makeClassProxy(resolver, 'com.example.app.Stub', { javaUse: customUse });
            expect(Stub.$obfName).toBe('aaaa');
            expect((Stub.$native as { tag: string }).tag).toBe('custom-aaaa');
        } finally {
            g.Java = saved;
        }
    });

    it('honours an explicit javaBridge (no global Java needed)', () => {
        const g = globalThis as { Java?: unknown };
        const saved = g.Java;
        try {
            delete (g as Record<string, unknown>).Java;
            registerStubViaCustomRegistry();
            const resolver = createResolver(map);
            const bridge = javaBridgeFromUse((obf: string) => customRegistry.get(obf));
            const Stub = makeClassProxy(resolver, 'com.example.app.Stub', { javaBridge: bridge });
            expect(Stub.$obfName).toBe('aaaa');
            expect((Stub.$native as { tag: string }).tag).toBe('custom-aaaa');
        } finally {
            g.Java = saved;
        }
    });

    it('prefers javaBridge over javaUse when both are given', () => {
        registerStubViaCustomRegistry();
        const resolver = createResolver(map);
        const bridge = javaBridgeFromUse((obf: string) => customRegistry.get(obf));
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub', {
            javaBridge: bridge,
            javaUse: () => {
                throw new Error('javaUse should not be consulted when javaBridge is set');
            },
        });
        expect((Stub.$native as { tag: string }).tag).toBe('custom-aaaa');
    });
});

// A tiny in-test registry to exercise the javaUse override path without
// going through the Frida mock.
const customRegistry = new Map<string, { tag: string; $new: () => unknown; class: unknown }>();
function registerStubViaCustomRegistry(): void {
    customRegistry.clear();
    customRegistry.set('aaaa', {
        tag: 'custom-aaaa',
        $new: () => ({ $className: 'aaaa' }),
        class: { getName: () => 'aaaa' },
    });
}
