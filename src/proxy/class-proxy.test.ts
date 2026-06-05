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
import { EventBus } from '../diagnostics/event-bus.js';
import { ResolveError, UnresolvedAccessError } from '../errors.js';
import { javaBridgeFromUse } from '../java-bridge.js';
import { createResolver } from '../resolver/index.js';
import { isSentinel } from '../resolver/sentinel.js';
import type { RosettaMap } from '../types/map.js';
import { ROSETTA_META, type ProxyMeta } from '../types/proxy.js';
import { validateMap } from '../validate/schema.js';
import { makeClassProxy } from './class-proxy.js';

// Authored in the terser single-overload form; validateMap normalises
// methods to arrays so the proxy/resolver see the in-memory shape.
const map: RosettaMap = validateMap({
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
});

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

describe('makeClassProxy — $-metadata collision', () => {
    useFridaMock();

    const collidingMap: RosettaMap = validateMap({
        schema_version: 2,
        version_code: 1,
        app: 'com.example.app',
        version: '1.0.0',
        classes: {
            'com.example.app.Weird': {
                obfuscated: 'wwww',
                // A hostile/unlucky map naming members like the metadata keys.
                methods: { $new: { obfuscated: 'n', signature: '()V' } },
                fields: { $native: { obfuscated: 'v', type: 'I', static: true } },
            },
        },
    });

    function registerWeird(): void {
        MockFrida.registerClass('wwww', {
            methods: { n: [{ argumentTypes: [], returnType: { className: 'void' } }] },
            fields: { v: { type: 'I', static: true, initial: 7 } },
        });
    }

    it('does not let a map member named $native shadow the real field member', () => {
        registerWeird();
        const resolver = createResolver(collidingMap);
        const Weird = makeClassProxy(resolver, 'com.example.app.Weird');
        // $native here is the MAP's field, not the native wrapper.
        const field = Weird.$native as { value: number };
        expect(field.value).toBe(7);
    });

    it('does not let a map member named $new shadow the real method member', () => {
        registerWeird();
        const resolver = createResolver(collidingMap);
        const Weird = makeClassProxy(resolver, 'com.example.app.Weird');
        // $new resolves to the map method handle, not the constructor helper.
        const handle = (Weird as unknown as Record<string, { overloads: unknown[] }>).$new;
        expect(Array.isArray(handle.overloads)).toBe(true);
    });

    it('always exposes metadata through the ROSETTA_META symbol', () => {
        registerWeird();
        const resolver = createResolver(collidingMap);
        const Weird = makeClassProxy(resolver, 'com.example.app.Weird');
        const meta = (Weird as unknown as Record<symbol, ProxyMeta>)[ROSETTA_META];
        expect(meta.realName).toBe('com.example.app.Weird');
        expect(meta.obfName).toBe('wwww');
        expect(meta.resolver).toBe(resolver);
        expect((meta.native as { $className: string }).$className).toBe('wwww');
    });

    it('keeps $-metadata working when the map does NOT collide', () => {
        registerStub();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        expect(Stub.$obfName).toBe('aaaa');
        expect((Stub.$native as { $className: string }).$className).toBe('aaaa');
    });
});

describe('makeClassProxy — override invalidation (live proxy revalidation)', () => {
    useFridaMock();

    function registerOverrideTarget(): void {
        // A second native class the override can re-map the proxy onto.
        MockFrida.registerClass('zzzz', {
            methods: {
                e: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
            fields: { t: { type: 'I', static: true, initial: 99 } },
        });
    }

    it('reflects a tier-3 override in a live proxy built before the override', () => {
        registerStub();
        registerOverrideTarget();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        // Sanity: pre-override the proxy points at 'aaaa'.
        expect(Stub.$obfName).toBe('aaaa');
        const beforeNative = Stub.$native as { $className: string };
        expect(beforeNative.$className).toBe('aaaa');

        // Override the class to a new obfuscated name + member set. Override
        // entries are in-memory ClassEntry values (methods are arrays).
        resolver.override('com.example.app.Stub', {
            obfuscated: 'zzzz',
            methods: { ping: [{ obfuscated: 'e', signature: '(Landroid/os/Bundle;)V' }] },
            fields: { COUNT: { obfuscated: 't', type: 'I', static: true } },
        });

        // The same live proxy now resolves through the override.
        expect(Stub.$obfName).toBe('zzzz');
        expect((Stub.$native as { $className: string }).$className).toBe('zzzz');
        // New member is reachable; the new field reads from the new class.
        const count = Stub.COUNT as { value: number };
        expect(count.value).toBe(99);
    });

    it('returns a sentinel for an unknown class under failurePolicy=warn', () => {
        registerStub();
        const resolver = createResolver(map, { failurePolicy: 'warn' });
        // Building the proxy must NOT throw — the miss is deferred.
        const Missing = makeClassProxy(resolver, 'com.example.app.DoesNotExist');
        expect(isSentinel(Missing)).toBe(true);
        // Using it throws clearly at the point of misuse.
        expect(() => (Missing as { anything: unknown }).anything).toThrow(UnresolvedAccessError);
    });

    it('still throws for an unknown class under the default strict policy', () => {
        registerStub();
        const resolver = createResolver(map); // default 'strict'
        expect(() => makeClassProxy(resolver, 'com.example.app.DoesNotExist')).toThrow(
            ResolveError,
        );
    });

    it('drops a stale memoized member handle after an override', () => {
        registerStub();
        registerOverrideTarget();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');
        // Cache the static-field accessor for the pre-override class.
        const before = Stub.STATIC_F as { value: number };
        expect(before.value).toBe(42);

        resolver.override('com.example.app.Stub', {
            obfuscated: 'zzzz',
            fields: { STATIC_F: { obfuscated: 't', type: 'I', static: true } },
        });

        // After the override, the cached accessor must be rebuilt against
        // the new class — not return the stale handle.
        const after = Stub.STATIC_F as { value: number };
        expect(after).not.toBe(before);
        expect(after.value).toBe(99);
    });

    it('drops a stale memoized METHOD handle after an override (method-handle path)', () => {
        registerStub();
        registerOverrideTarget();
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub');

        // Cache a method handle for the pre-override class: requestTicket → 'c'
        // on 'aaaa', taking (Bundle, Callback).
        const before = Stub.requestTicket as {
            overload: (...a: string[]) => { argumentTypes: { className: string }[] };
            $native: { holder?: { $className: string } };
        };
        const beforePicked = before.overload('android.os.Bundle', 'com.example.app.Callback');
        expect(beforePicked.argumentTypes.map((a) => a.className)).toEqual([
            'android.os.Bundle',
            'bbbb',
        ]);

        // Re-map the same real method onto a different obfuscated method on a
        // different class: requestTicket → 'e' on 'zzzz', taking (Bundle).
        resolver.override('com.example.app.Stub', {
            obfuscated: 'zzzz',
            methods: { requestTicket: [{ obfuscated: 'e', signature: '(Landroid/os/Bundle;)V' }] },
        });

        // Re-accessing the SAME real name must yield a NEW handle bound to the
        // new obfuscated method/class — not the stale cached one.
        const after = Stub.requestTicket as {
            overload: (...a: string[]) => { argumentTypes: { className: string }[] };
        };
        expect(after).not.toBe(before);
        // The new handle resolves the new overload shape ((Bundle) on 'e'),
        // proving it points at the post-override method, not the stale 'c'.
        const afterPicked = after.overload('android.os.Bundle');
        expect(afterPicked.argumentTypes.map((a) => a.className)).toEqual(['android.os.Bundle']);
        // And the stale 2-arg overload no longer exists on the new handle.
        expect(() => after.overload('android.os.Bundle', 'com.example.app.Callback')).toThrow();
    });

    it('does NOT rebuild a live proxy when an UNRELATED class is overridden (N1)', () => {
        registerStub();
        registerOverrideTarget();
        // Count Java.use(...) calls per obfuscated name so we can prove an
        // unrelated override does not trigger a fresh native round-trip.
        const useCounts = new Map<string, number>();
        const realJava = (globalThis as { Java: { use(n: string): unknown } }).Java;
        const countingBridge = {
            available: true,
            use(obf: string): unknown {
                useCounts.set(obf, (useCounts.get(obf) ?? 0) + 1);
                return realJava.use(obf);
            },
        };
        const resolver = createResolver(map);
        const Stub = makeClassProxy(resolver, 'com.example.app.Stub', {
            javaBridge: countingBridge,
        });
        // Cache a method handle on the live proxy.
        const handle = Stub.requestTicket;
        expect(useCounts.get('aaaa')).toBe(1); // one native build at construction
        expect(handle).toBeDefined();

        // Override a DIFFERENT class. The global epoch advances, but Stub's
        // resolved entry is unchanged, so the proxy must not re-`use('aaaa')`
        // nor drop its member cache.
        resolver.override('com.example.app.Callback', { obfuscated: 'zzzz' });

        // Same handle (member cache survived) and no extra native build.
        expect(Stub.requestTicket).toBe(handle);
        expect(Stub.$obfName).toBe('aaaa');
        expect(useCounts.get('aaaa')).toBe(1);
    });
});

describe('makeClassProxy — construction (no duplicate resolve, N2)', () => {
    useFridaMock();

    it('emits exactly one resolve event on construction (no spurious cache event)', () => {
        registerStub();
        const events = new EventBus();
        const seen: { source?: string }[] = [];
        events.on((e) => {
            if (e.type === 'resolve') seen.push({ source: e.source });
        });
        const resolver = createResolver(map, { events });
        makeClassProxy(resolver, 'com.example.app.Stub');
        // Previously the proxy resolved twice at construction (once for the
        // sentinel check, once in an eager revalidate) emitting a 'map' then a
        // spurious 'cache' event. It must now emit a single 'map' resolve.
        expect(seen).toEqual([{ source: 'map' }]);
    });
});
