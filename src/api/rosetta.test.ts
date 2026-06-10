import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResolveError, RosettaError, TargetPolicyError, UnresolvedAccessError } from '../errors.js';
import { isSentinel } from '../resolver/sentinel.js';
import type { RosettaMap } from '../types/map.js';
import { validateMap } from '../validate/schema.js';
import { MockFrida, installFridaMock, resetFridaMock } from '../../tests/mocks/index.js';
import { _resetCurrentSession, getCurrentSession, rosetta } from './rosetta.js';

function makeMap(): RosettaMap {
    // Sessions consume already-validated (normalised) maps; author in the
    // terser single-overload form and normalise via validateMap.
    return validateMap({
        schema_version: 4,
        version_code: 1,
        app: 'com.example.app',
        version: '3.4.5',
        classes: {
            'com.example.app.IFoo$Stub': {
                obfuscated: 'aaaa',
                kind: 'class',
                methods: {
                    requestTicket: {
                        obfuscated: 'c',
                        signature: '(Landroid/os/Bundle;)V',
                    },
                },
                fields: {
                    sessionId: { obfuscated: 'a', type: 'Ljava/lang/String;' },
                },
            },
        },
    });
}

function registerForResolve(): void {
    MockFrida.registerClass('aaaa', {
        methods: {
            c: [
                {
                    argumentTypes: [{ className: 'android.os.Bundle' }],
                    returnType: { className: 'void' },
                },
            ],
        },
        fields: {
            a: { type: 'java.lang.String', initial: 'hello' },
        },
    });
}

describe('rosetta ambient namespace', () => {
    beforeEach(() => {
        installFridaMock();
        _resetCurrentSession();
    });

    afterEach(() => {
        _resetCurrentSession();
        resetFridaMock();
    });

    it('throws a RosettaError when any ambient method is called before session()', () => {
        expect(() => rosetta.use('IFoo')).toThrow(RosettaError);
        expect(() => rosetta.use('IFoo')).toThrow(/no active rosetta session/);
        expect(() => rosetta.type('IFoo')).toThrow(RosettaError);
        expect(() => rosetta.hook('IFoo.bar', () => null)).toThrow(RosettaError);
        expect(() => rosetta.field({}, 'sessionId')).toThrow(RosettaError);
        expect(() => rosetta.setField({}, 'sessionId', 'x')).toThrow(RosettaError);
        expect(() => rosetta.map).toThrow(RosettaError);
        expect(() => rosetta.events).toThrow(RosettaError);
        expect(() => getCurrentSession()).toThrow(RosettaError);
    });

    it('session() creates a session and returns the public Session view', () => {
        const s = rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        expect(s.app).toBe('com.example.app');
        expect(s.version).toBe('3.4.5');
        expect(s.map.schema_version).toBe(4);
    });

    it('getCurrentSession returns the latest session set via session()', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const s1 = getCurrentSession();

        // Replacing the session updates the ambient.
        const newMap = { ...makeMap(), version: '3.5.0' };
        rosetta.session({
            map: newMap,
            app: 'com.example.app',
            version: '3.5.0',
            skipHealthCheck: true,
        });
        const s2 = getCurrentSession();
        expect(s2).not.toBe(s1);
        expect(s2.version).toBe('3.5.0');
    });

    it('use() returns a class proxy bound to the current resolver', () => {
        registerForResolve();
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const Stub = rosetta.use('com.example.app.IFoo$Stub');
        expect(Stub.$realName).toBe('com.example.app.IFoo$Stub');
        expect(Stub.$obfName).toBe('aaaa');
    });

    it('use() defers a missing class to a sentinel under the default warn policy', () => {
        registerForResolve();
        // Default session failurePolicy is 'warn'; the policy must flow all
        // the way to rosetta.use so a missing class no longer crashes the
        // call but throws clearly only when the proxy is used.
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const Missing = rosetta.use('com.example.app.NotInMap');
        expect(isSentinel(Missing)).toBe(true);
        expect(() => (Missing as { whatever: unknown }).whatever).toThrow(UnresolvedAccessError);
    });

    it('use() throws for a missing class under explicit strict policy', () => {
        registerForResolve();
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
            failurePolicy: 'strict',
        });
        expect(() => rosetta.use('com.example.app.NotInMap')).toThrow(ResolveError);
    });

    it('type() translates a real-name type to obfuscated', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        expect(rosetta.type('com.example.app.IFoo$Stub')).toBe('aaaa');
        // Framework types pass through.
        expect(rosetta.type('android.os.Bundle')).toBe('android.os.Bundle');
    });

    it('hook() installs a tier-1 hook through the ambient resolver', () => {
        registerForResolve();
        // hook() needs a stable Java wrapper (real Frida shares state across
        // Java.use calls). The mock returns a fresh wrapper per call so the
        // installed `.implementation` is lost without this spy.
        const cache = new Map<string, ReturnType<typeof Java.use>>();
        const original = Java.use.bind(Java);
        vi.spyOn(Java, 'use').mockImplementation((name: string) => {
            const cached = cache.get(name);
            if (cached) return cached;
            const w = original(name);
            cache.set(name, w);
            return w;
        });

        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });

        const handle = rosetta.hook('com.example.app.IFoo$Stub.requestTicket', () => 'patched');
        expect(handle.detached).toBe(false);
        handle.detach();
        expect(handle.detached).toBe(true);
    });

    it('field() / setField() round-trip via the ambient resolver', () => {
        registerForResolve();
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const Klass = Java.use('aaaa');
        const inst = Klass.$new();
        expect(rosetta.field(inst, 'sessionId')).toBe('hello');
        rosetta.setField(inst, 'sessionId', 'world');
        expect(rosetta.field(inst, 'sessionId')).toBe('world');
    });

    it('proceed is re-exported as the raw tier-1 helper', () => {
        // proceed has no session dependency; called outside any hook
        // implementation, it throws clearly. (The full behavior is in
        // tier-1's own test suite.)
        expect(() => rosetta.proceed()).toThrow(/proceed/);
    });

    it('map getter exposes the tier-3 resolver surface bound to current session', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const resolved = rosetta.map.resolveClass('com.example.app.IFoo$Stub');
        expect(resolved.obfName).toBe('aaaa');

        const m = rosetta.map.resolveMethod('com.example.app.IFoo$Stub', 'requestTicket');
        expect(m.obfName).toBe('c');

        const f = rosetta.map.resolveField('com.example.app.IFoo$Stub', 'sessionId');
        expect(f.obfName).toBe('a');

        const extracted = rosetta.map.extract();
        expect(extracted.app).toBe('com.example.app');

        // override forces a different obfuscation; subsequent resolve sees it.
        rosetta.map.override('com.example.app.IFoo$Stub', {
            obfuscated: 'zzzz',
            methods: { requestTicket: { obfuscated: 'd', signature: '()V' } },
            fields: {},
        });
        expect(rosetta.map.resolveClass('com.example.app.IFoo$Stub').obfName).toBe('zzzz');
    });

    it('events getter subscribes to the current session bus', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });

        const seen: string[] = [];
        const off = rosetta.events.on((e) => {
            if (e.type === 'resolve') seen.push(e.name);
        });

        // Trigger a resolve to confirm the listener fires.
        rosetta.map.resolveClass('com.example.app.IFoo$Stub');
        expect(seen).toContain('com.example.app.IFoo$Stub');

        off();
        const before = seen.length;
        rosetta.map.resolveClass('com.example.app.IFoo$Stub');
        expect(seen.length).toBe(before); // listener detached
    });

    it('events.onType filters by event type', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });

        const detects: string[] = [];
        const offDetect = rosetta.events.onType('detect', (e) => detects.push(e.app));
        // Detect events fire during session construction (which is already
        // past at this point). Force one by emitting through the bus.
        // We use the same bus by calling getCurrentSession().events.emit.
        getCurrentSession().events.emit({
            type: 'detect',
            app: 'com.example.app',
            version: '3.4.5',
            source: 'auto',
        });
        expect(detects).toEqual(['com.example.app']);
        offDetect();
    });
});

describe('rosetta — re-attach / singleton semantics (L12)', () => {
    beforeEach(() => {
        installFridaMock();
        _resetCurrentSession();
    });

    afterEach(() => {
        _resetCurrentSession();
        resetFridaMock();
    });

    it('a second session() cleanly supersedes the first — does not throw', () => {
        const s1 = rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        // Re-attach: a second call must REPLACE, not throw or stack.
        const newMap = { ...makeMap(), version: '3.5.0' };
        const s2 = rosetta.session({
            map: newMap,
            app: 'com.example.app',
            version: '3.5.0',
            skipHealthCheck: true,
        });
        expect(s2).not.toBe(s1);
        // Ambient now routes through the new session deterministically.
        expect(getCurrentSession()).toBe(s2);
        expect(getCurrentSession().version).toBe('3.5.0');
    });

    it('swapping sessions clears the superseded session bus (no listener leak)', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const firstBus = getCurrentSession().events;
        const seen: string[] = [];
        firstBus.on((e) => {
            if (e.type === 'detect') seen.push(e.app);
        });

        // Re-attach to a new session.
        rosetta.session({
            map: { ...makeMap(), version: '3.5.0' },
            app: 'com.example.app',
            version: '3.5.0',
            skipHealthCheck: true,
        });

        // The old bus's subscriber must no longer fire — it was cleared on swap.
        firstBus.emit({
            type: 'detect',
            app: 'com.example.app',
            version: '3.4.5',
            source: 'auto',
        });
        expect(seen).toEqual([]);
    });

    it('reset() disposes the session; ambient calls then throw as before first session()', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        expect(() => getCurrentSession()).not.toThrow();

        rosetta.reset();

        // No active session → the same RosettaError as a fresh process.
        expect(() => getCurrentSession()).toThrow(RosettaError);
        expect(() => rosetta.use('com.example.app.IFoo$Stub')).toThrow(/no active rosetta session/);
        expect(() => rosetta.map).toThrow(RosettaError);
    });

    it('reset() clears the disposed session bus (no stale subscriber)', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const bus = getCurrentSession().events;
        const seen: string[] = [];
        bus.on((e) => {
            if (e.type === 'detect') seen.push(e.app);
        });

        rosetta.reset();

        bus.emit({ type: 'detect', app: 'com.example.app', version: '3.4.5', source: 'auto' });
        expect(seen).toEqual([]);
    });

    it('reset() is idempotent — a no-op when no session is active', () => {
        // No session opened yet.
        expect(() => rosetta.reset()).not.toThrow();
        expect(() => rosetta.reset()).not.toThrow();
        expect(() => getCurrentSession()).toThrow(RosettaError);
    });

    it('an unsubscribe token obtained before reset() is a safe no-op afterward', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        // Subscribe via the ambient events surface and capture the token.
        const unsubscribe = rosetta.events.on(() => {});

        rosetta.reset();

        // Calling the token after the bus was cleared must not throw — it is
        // an inert `Set.delete` of an already-absent entry.
        expect(() => unsubscribe()).not.toThrow();
    });

    it('a subscriber added before a session swap does NOT receive the new session events', () => {
        // Contract: subscriptions are per-session. The bus is cleared on swap,
        // and the new session gets a FRESH bus — so a listener attached to the
        // old session never sees the new session's events. Callers that want to
        // keep observing after a swap must RE-SUBSCRIBE on the new session.
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const seen: string[] = [];
        rosetta.events.on((e) => {
            if (e.type === 'detect') seen.push(e.version);
        });

        // Swap to a new session (fresh bus).
        rosetta.session({
            map: { ...makeMap(), version: '3.5.0' },
            app: 'com.example.app',
            version: '3.5.0',
            skipHealthCheck: true,
        });

        // Emit on the NEW session's bus — the old subscriber must not fire.
        getCurrentSession().events.emit({
            type: 'detect',
            app: 'com.example.app',
            version: '3.5.0',
            source: 'auto',
        });
        expect(seen).toEqual([]);

        // Re-subscribe semantics: a listener attached to the new session does fire.
        rosetta.events.on((e) => {
            if (e.type === 'detect') seen.push(e.version);
        });
        getCurrentSession().events.emit({
            type: 'detect',
            app: 'com.example.app',
            version: '3.5.0',
            source: 'auto',
        });
        expect(seen).toEqual(['3.5.0']);
    });

    it('a fresh session() after reset() re-initialises cleanly with no stale state', () => {
        rosetta.session({
            map: makeMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        rosetta.reset();

        // Re-open: the new session is fully usable and carries only its own map.
        rosetta.session({
            map: { ...makeMap(), version: '9.9.9' },
            app: 'com.example.app',
            version: '9.9.9',
            skipHealthCheck: true,
        });
        expect(getCurrentSession().version).toBe('9.9.9');
        expect(rosetta.map.extract().version).toBe('9.9.9');
    });
});

describe('rosetta — target-namespace guard end-to-end (RFC 0001 C1)', () => {
    beforeEach(() => {
        installFridaMock();
        _resetCurrentSession();
    });
    afterEach(() => {
        _resetCurrentSession();
        resetFridaMock();
    });

    function maliciousMap(): RosettaMap {
        return {
            schema_version: 4,
            version_code: 1,
            app: 'com.example.app',
            version: '3.4.5',
            classes: {
                'com.example.app.Evil': {
                    obfuscated: 'java.lang.Runtime',
                    methods: { exec: { obfuscated: 'm', signature: '()V' } },
                },
            },
        };
    }

    /** The mocked Java.use (a vi.fn) on the global. */
    function javaUseMock(): ReturnType<typeof vi.fn> {
        return (globalThis as unknown as { Java: { use: ReturnType<typeof vi.fn> } }).Java.use;
    }

    it('rosetta.use throws TargetPolicyError BEFORE Java.use is called', () => {
        rosetta.session({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const useSpy = javaUseMock();
        useSpy.mockClear();
        expect(() => rosetta.use('com.example.app.Evil')).toThrow(TargetPolicyError);
        expect(useSpy).not.toHaveBeenCalled();
    });

    it('rosetta.hook throws TargetPolicyError BEFORE Java.use is called', () => {
        rosetta.session({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        const useSpy = javaUseMock();
        useSpy.mockClear();
        expect(() => rosetta.hook('com.example.app.Evil.exec', () => null)).toThrow(
            TargetPolicyError,
        );
        expect(useSpy).not.toHaveBeenCalled();
    });

    it('the default (omitted) policy rejects a framework target with no config', () => {
        // No targetPolicy supplied — the built-in fail-closed default applies.
        rosetta.session({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
        });
        expect(() => rosetta.use('com.example.app.Evil')).toThrow(/reserved denylist/);
    });

    it('an explicit allow escape-hatch lets a legit framework hook through', () => {
        rosetta.session({
            map: maliciousMap(),
            app: 'com.example.app',
            version: '3.4.5',
            skipHealthCheck: true,
            targetPolicy: { allow: ['java.lang.Runtime'] },
        });
        // Register the framework class on the mock so the proxy can resolve it.
        MockFrida.registerClass('java.lang.Runtime', {
            methods: { m: [{ argumentTypes: [], returnType: { className: 'void' } }] },
        });
        const proxy = rosetta.use('com.example.app.Evil');
        expect(proxy.$obfName).toBe('java.lang.Runtime');
        expect(javaUseMock()).toHaveBeenCalledWith('java.lang.Runtime');
    });
});
