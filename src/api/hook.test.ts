/**
 * Tests for `hook(...)` — tier-1 declarative method-hook installation.
 *
 * Drives the real Resolver against the Frida mock, so the tests
 * exercise the full pipeline: real-name target → resolver → obf
 * lookup → Java.use(obf) → overload selection → implementation
 * install → detach restores prior state.
 *
 * Note on mock semantics: the Frida mock's `Java.use(name)` returns
 * a fresh wrapper each call (each call rebuilds the MockMethod
 * instances). Real Frida wrappers share state through the JVM. To
 * simulate that, these tests cache `Java.use(name)` per (test, name)
 * via a beforeEach-installed spy. That mirrors how real Frida
 * behaves and lets the test verify post-install state by reading
 * the same wrapper that `hook()` wrote to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AmbiguousOverloadError, ResolveError } from '../errors.js';
import { createResolver } from '../resolver/index.js';
import { validateMap } from '../validate/schema.js';
import type { RosettaMap } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import { javaBridgeFromUse, JAVA_UNAVAILABLE_MESSAGE } from '../java-bridge.js';
import { proceed, _resetProceedStack } from './proceed.js';
import { hook, type HookHandle } from './hook.js';
import { MockFrida, installFridaMock, resetFridaMock } from '../../tests/mocks/index.js';

function buildMap(): RosettaMap {
    return {
        schema_version: 3,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {
            'com.example.app.IRemoteService$Stub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
                methods: {
                    // Single overload — string form must pick this.
                    onConnect: { obfuscated: 'a', signature: '()V' },
                    // Multi-overload — string form must throw Ambiguous.
                    requestTicket: [
                        {
                            obfuscated: 'c',
                            signature: '(Landroid/os/Bundle;Lbbbb;)V',
                            aidl_txn: 2,
                        },
                        {
                            obfuscated: 'd',
                            signature: '(Landroid/os/Bundle;Ljava/lang/String;Lbbbb;)V',
                            aidl_txn: 4,
                        },
                    ],
                    // For primitive-args coverage.
                    setFlag: { obfuscated: 'e', signature: '(Z[I)V' },
                },
            },
            IServiceCallback: {
                obfuscated: 'bbbb',
                kind: 'aidl_callback',
            },
        },
    };
}

interface Harness {
    resolver: Resolver;
    /** Wrapper-cache-friendly accessor — same instance per name within a test. */
    use: (name: string) => Record<string, unknown>;
}

/** Set up a fresh resolver + mock registry + Java.use cache for one test. */
function makeHarness(): Harness {
    const map = validateMap(buildMap());
    const resolver = createResolver(map);

    MockFrida.registerClass('aaaa', {
        methods: {
            a: [{ argumentTypes: [], returnType: { className: 'void' } }],
            c: [
                {
                    argumentTypes: [{ className: 'android.os.Bundle' }, { className: 'bbbb' }],
                    returnType: { className: 'void' },
                },
            ],
            d: [
                {
                    argumentTypes: [
                        { className: 'android.os.Bundle' },
                        { className: 'java.lang.String' },
                        { className: 'bbbb' },
                    ],
                    returnType: { className: 'void' },
                },
            ],
            e: [
                {
                    argumentTypes: [{ className: 'boolean' }, { className: '[I' }],
                    returnType: { className: 'void' },
                },
            ],
        },
    });
    MockFrida.registerClass('bbbb', {});

    // Cache wrappers per name so writes are observable.
    const cache = new Map<string, Record<string, unknown>>();
    vi.spyOn(Java, 'use').mockImplementation((name: string) => {
        let w = cache.get(name);
        if (!w) {
            w = MockFrida.use(name);
            cache.set(name, w);
        }
        return w as never;
    });

    return {
        resolver,
        use: (name: string) => Java.use(name),
    };
}

/** Pull the first overload of the named method off the wrapper. */
function firstOverload(
    wrapper: Record<string, unknown>,
    obfMethod: string,
): { implementation: ((this: unknown, ...a: unknown[]) => unknown) | null } {
    const m = wrapper[obfMethod] as {
        overloads: { implementation: ((this: unknown, ...a: unknown[]) => unknown) | null }[];
    };
    const ol = m.overloads[0];
    if (!ol) throw new Error('test setup: no first overload');
    return ol;
}

beforeEach(() => {
    installFridaMock();
});
afterEach(() => {
    resetFridaMock();
    _resetProceedStack();
});

describe('hook — string form', () => {
    it('installs an impl on a single-overload method and returns a HookHandle', () => {
        const h = makeHarness();
        let captured: unknown[] | null = null;
        const handle = hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function (this: unknown, ...args: unknown[]) {
                captured = args;
                return 'hooked';
            },
            { resolver: h.resolver },
        );

        expect(handle.detached).toBe(false);

        const ol = firstOverload(h.use('aaaa'), 'a');
        const result = ol.implementation?.call({});
        expect(result).toBe('hooked');
        expect(captured).toEqual([]);
    });

    it('passes args through to the user impl', () => {
        const h = makeHarness();
        let captured: unknown[] = [];
        hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function (this: unknown, ...args: unknown[]) {
                captured = args;
                return undefined;
            },
            { resolver: h.resolver },
        );
        const ol = firstOverload(h.use('aaaa'), 'a');
        ol.implementation?.call({}, 'x', 'y');
        expect(captured).toEqual(['x', 'y']);
    });

    it('throws ResolveError when the class is not in the map', () => {
        const h = makeHarness();
        expect(() =>
            hook('com.example.UnknownClass.foo', () => undefined, { resolver: h.resolver }),
        ).toThrow(ResolveError);
    });

    it('throws ResolveError when the method is not in the map', () => {
        const h = makeHarness();
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.missingMethod', () => undefined, {
                resolver: h.resolver,
            }),
        ).toThrow(ResolveError);
    });

    it('throws AmbiguousOverloadError when string form names a multi-overload', () => {
        const h = makeHarness();
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.requestTicket', () => undefined, {
                resolver: h.resolver,
            }),
        ).toThrow(AmbiguousOverloadError);
    });

    it('rejects a malformed target string with no dot', () => {
        const h = makeHarness();
        expect(() => hook('noDotHere', () => undefined, { resolver: h.resolver })).toThrow(
            /must be of the form/,
        );
    });

    it('rejects a target string ending in a dot', () => {
        const h = makeHarness();
        expect(() => hook('Foo.', () => undefined, { resolver: h.resolver })).toThrow(
            /must be of the form/,
        );
    });

    it('rejects a target string starting with a dot', () => {
        const h = makeHarness();
        expect(() => hook('.foo', () => undefined, { resolver: h.resolver })).toThrow(
            /must be of the form/,
        );
    });
});

describe('hook — object form', () => {
    it('selects the right overload by real-name arg types', () => {
        const h = makeHarness();
        hook(
            {
                class: 'com.example.app.IRemoteService$Stub',
                method: 'requestTicket',
                args: ['android.os.Bundle', 'IServiceCallback'],
            },
            function () {
                return 'two-arg';
            },
            { resolver: h.resolver },
        );

        const wrapper = h.use('aaaa');
        const olC = firstOverload(wrapper, 'c');
        const olD = firstOverload(wrapper, 'd');
        expect(olC.implementation?.call({})).toBe('two-arg');
        // d must NOT have received an impl.
        expect(olD.implementation).toBeNull();
    });

    it('selects the other overload by arg types', () => {
        const h = makeHarness();
        hook(
            {
                class: 'com.example.app.IRemoteService$Stub',
                method: 'requestTicket',
                args: ['android.os.Bundle', 'java.lang.String', 'IServiceCallback'],
            },
            function () {
                return 'three-arg';
            },
            { resolver: h.resolver },
        );

        const wrapper = h.use('aaaa');
        const olC = firstOverload(wrapper, 'c');
        const olD = firstOverload(wrapper, 'd');
        expect(olD.implementation?.call({})).toBe('three-arg');
        expect(olC.implementation).toBeNull();
    });

    it('throws ResolveError when no overload matches the given args', () => {
        const h = makeHarness();
        expect(() =>
            hook(
                {
                    class: 'com.example.app.IRemoteService$Stub',
                    method: 'requestTicket',
                    args: ['android.os.Bundle'], // no such overload
                },
                () => undefined,
                { resolver: h.resolver },
            ),
        ).toThrow(ResolveError);
    });

    it('handles primitive + array arg types in the signature', () => {
        const h = makeHarness();
        hook(
            {
                class: 'com.example.app.IRemoteService$Stub',
                method: 'setFlag',
                args: ['boolean', '[I'],
            },
            function () {
                return 'ok';
            },
            { resolver: h.resolver },
        );
        const ol = firstOverload(h.use('aaaa'), 'e');
        expect(ol.implementation?.call({})).toBe('ok');
    });
});

describe('hook.detach', () => {
    it('restores the previous implementation', () => {
        const h = makeHarness();

        // Pre-install a previous implementation on the cached wrapper.
        const wrapper = h.use('aaaa');
        const ol = firstOverload(wrapper, 'a');
        const originalImpl = function () {
            return 'original';
        };
        ol.implementation = originalImpl;

        const handle = hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function () {
                return 'hooked';
            },
            { resolver: h.resolver },
        );
        expect(ol.implementation?.call({})).toBe('hooked');

        handle.detach();
        expect(handle.detached).toBe(true);
        expect(ol.implementation).toBe(originalImpl);
        expect(ol.implementation?.call({})).toBe('original');
    });

    it('restores null when there was no prior implementation', () => {
        const h = makeHarness();
        const handle = hook('com.example.app.IRemoteService$Stub.onConnect', () => 'hooked', {
            resolver: h.resolver,
        });
        handle.detach();

        const ol = firstOverload(h.use('aaaa'), 'a');
        expect(ol.implementation).toBeNull();
    });

    it('detach is idempotent', () => {
        const h = makeHarness();
        const handle = hook('com.example.app.IRemoteService$Stub.onConnect', () => 'hooked', {
            resolver: h.resolver,
        });
        handle.detach();
        const ol = firstOverload(h.use('aaaa'), 'a');
        const sentinel = () => 'post-detach';
        ol.implementation = sentinel;

        handle.detach(); // no-op
        expect(ol.implementation).toBe(sentinel);
    });
});

describe('hook + proceed', () => {
    it('proceed inside the impl forwards to the next-in-chain', () => {
        const h = makeHarness();
        // Pre-install an "original" we can chain to. Must happen on
        // the cached wrapper so `hook()` sees it as the prior impl.
        const wrapper = h.use('aaaa');
        const olC = firstOverload(wrapper, 'c');
        olC.implementation = function (this: unknown, ...args: unknown[]) {
            return `orig(${args.join(',')})`;
        };

        let userArgsSeen: unknown[] = [];
        hook(
            {
                class: 'com.example.app.IRemoteService$Stub',
                method: 'requestTicket',
                args: ['android.os.Bundle', 'IServiceCallback'],
            },
            function (this: unknown, ...args: unknown[]) {
                userArgsSeen = args;
                return proceed(...args, 'extra');
            },
            { resolver: h.resolver },
        );

        const result = olC.implementation?.call({ tag: 'inst' }, 'bundle', 'cb');
        expect(userArgsSeen).toEqual(['bundle', 'cb']);
        expect(result).toBe('orig(bundle,cb,extra)');
    });

    it('proceed propagates `this` to the previous impl', () => {
        const h = makeHarness();
        const wrapper = h.use('aaaa');
        const ol = firstOverload(wrapper, 'a');
        ol.implementation = function (this: { tag: string }) {
            return `orig-this:${this.tag}`;
        };

        hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function () {
                return proceed();
            },
            { resolver: h.resolver },
        );
        const result = ol.implementation?.call({ tag: 'theThis' });
        expect(result).toBe('orig-this:theThis');
    });

    it('proceed returns undefined when there is no underlying impl', () => {
        const h = makeHarness();
        hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function () {
                return proceed('x');
            },
            { resolver: h.resolver },
        );
        const ol = firstOverload(h.use('aaaa'), 'a');
        expect(ol.implementation?.call({})).toBeUndefined();
    });

    it('pop runs even if the user impl throws', () => {
        const h = makeHarness();
        hook(
            'com.example.app.IRemoteService$Stub.onConnect',
            function () {
                throw new Error('boom');
            },
            { resolver: h.resolver },
        );
        const ol = firstOverload(h.use('aaaa'), 'a');
        expect(() => ol.implementation?.call({})).toThrow('boom');
        // And the proceed stack must be empty now.
        expect(() => proceed()).toThrow(/outside a hook implementation/);
    });
});

describe('hook — failurePolicy', () => {
    it('throws ResolveError for a missing method under strict (default)', () => {
        const h = makeHarness();
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.noSuchMethod', () => undefined, {
                resolver: h.resolver,
            }),
        ).toThrow(ResolveError);
    });

    it('is a no-op (already-detached handle) for a missing method under warn', () => {
        // Build a warn-policy resolver + mock registry inline.
        const resolver = createResolver(validateMap(buildMap()), { failurePolicy: 'warn' });
        MockFrida.registerClass('aaaa', {
            methods: { a: [{ argumentTypes: [], returnType: { className: 'void' } }] },
        });
        MockFrida.registerClass('bbbb', {});
        const handle = hook('com.example.app.IRemoteService$Stub.noSuchMethod', () => undefined, {
            resolver,
        });
        expect(handle.detached).toBe(true);
        // detach() on the no-op handle is safe.
        expect(() => handle.detach()).not.toThrow();
    });
});

describe('hook — environment errors', () => {
    it('throws the canonical error when the Java bridge is unavailable', () => {
        const h = makeHarness();
        // Inject an unavailable bridge instead of mutating globalThis — the
        // bridge is the seam, so the test drives it directly.
        const unavailableBridge = javaBridgeFromUse(undefined);
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.onConnect', () => undefined, {
                resolver: h.resolver,
                javaBridge: unavailableBridge,
            }),
        ).toThrow(JAVA_UNAVAILABLE_MESSAGE);
    });

    it('routes hook installation through an injected Java bridge', () => {
        const h = makeHarness();
        // A bridge that delegates to the mock proves hook() uses the seam,
        // not a hard-coded globalThis read.
        const calls: string[] = [];
        const bridge = {
            available: true,
            use: (name: string) => {
                calls.push(name);
                return Java.use(name);
            },
        };
        hook('com.example.app.IRemoteService$Stub.onConnect', () => undefined, {
            resolver: h.resolver,
            javaBridge: bridge,
        });
        expect(calls).toContain('aaaa');
    });

    it('throws if the native wrapper is missing the obf method', () => {
        const h = makeHarness();
        vi.spyOn(Java, 'use').mockImplementationOnce(() => ({}) as never);
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.onConnect', () => undefined, {
                resolver: h.resolver,
            }),
        ).toThrow(/not present on native wrapper/);
    });

    it('throws if the method bundle has no .overload', () => {
        const h = makeHarness();
        vi.spyOn(Java, 'use').mockImplementationOnce(
            () =>
                ({
                    a: {
                        /* no .overload */
                    },
                }) as never,
        );
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.onConnect', () => undefined, {
                resolver: h.resolver,
            }),
        ).toThrow(/missing \.overload\(\)/);
    });

    it('propagates non-Rosetta resolver errors unchanged', () => {
        // Resolver errors flow through hook unwrapped (callers want to
        // pattern-match on the original exception). A fake resolver
        // throwing TypeError confirms that branch isn't accidentally
        // wrapped.
        const fakeResolver = {
            resolveMethod() {
                throw new TypeError('synthetic resolver failure');
            },
        } as unknown as Resolver;
        expect(() =>
            hook('com.example.app.IRemoteService$Stub.onConnect', () => undefined, {
                resolver: fakeResolver,
            }),
        ).toThrow(TypeError);
    });
});

describe('hook — descriptor parser edge cases', () => {
    function setupForSig(
        sig: string,
        args: { className: string }[],
    ): {
        resolver: Resolver;
        installHook: () => HookHandle;
    } {
        const map: RosettaMap = {
            schema_version: 3,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                Klass: {
                    obfuscated: 'k',
                    methods: { m: { obfuscated: 'm', signature: sig } },
                },
            },
        };
        const resolver = createResolver(validateMap(map));
        MockFrida.registerClass('k', {
            methods: {
                m: [{ argumentTypes: args, returnType: { className: 'void' } }],
            },
        });
        return {
            resolver,
            installHook: () => hook('Klass.m', () => 'ok', { resolver }),
        };
    }

    it('parses every primitive descriptor', () => {
        const setup = setupForSig('(ZBCSIJFD)V', [
            { className: 'boolean' },
            { className: 'byte' },
            { className: 'char' },
            { className: 'short' },
            { className: 'int' },
            { className: 'long' },
            { className: 'float' },
            { className: 'double' },
        ]);
        expect(() => setup.installHook()).not.toThrow();
    });

    it('parses array-of-primitive descriptors', () => {
        const setup = setupForSig('([I)V', [{ className: '[I' }]);
        expect(() => setup.installHook()).not.toThrow();
    });

    it('parses array-of-object descriptors', () => {
        const setup = setupForSig('([Ljava/lang/String;)V', [{ className: '[Ljava.lang.String;' }]);
        expect(() => setup.installHook()).not.toThrow();
    });

    it('parses void-only signature', () => {
        const setup = setupForSig('()V', []);
        expect(() => setup.installHook()).not.toThrow();
    });

    // The hook layer now delegates to the shared descriptor parser
    // (resolver/signature.ts), so these assert that parser's messages.
    it('throws on missing opening paren', () => {
        const setup = setupForSig('I)V', [{ className: 'int' }]);
        expect(() => setup.installHook()).toThrow(/signature must start with/);
    });

    it('throws on missing closing paren', () => {
        const setup = setupForSig('(I', [{ className: 'int' }]);
        expect(() => setup.installHook()).toThrow(/signature missing/);
    });

    it('throws on unterminated L-class ref', () => {
        const setup = setupForSig('(Ljava/lang/String)V', [{ className: 'java.lang.String' }]);
        expect(() => setup.installHook()).toThrow(/unterminated 'L' descriptor/);
    });

    it('throws on unknown primitive code', () => {
        const setup = setupForSig('(Q)V', [{ className: 'int' }]);
        expect(() => setup.installHook()).toThrow(/unknown descriptor char/);
    });

    it('throws on trailing `[` with no element type', () => {
        const setup = setupForSig('([)V', [{ className: '[' }]);
        expect(() => setup.installHook()).toThrow(/array prefix without element/);
    });
});
