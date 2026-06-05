import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RosettaError, TargetPolicyError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { MockFrida, installFridaMock, resetFridaMock } from '../../tests/mocks/index.js';
import { _resetCurrentSession, getCurrentSession, rosetta } from './rosetta.js';

function makeMap(): RosettaMap {
    return {
        schema_version: 2,
        version_code: 1,
        app: 'com.example.app',
        version: '3.4.5',
        classes: {
            'com.example.app.IFoo$Stub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
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
    };
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
        expect(s.map.schema_version).toBe(2);
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
            schema_version: 2,
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
