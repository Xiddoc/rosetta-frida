/**
 * Smoke test — proves the scaffolding compiles, the Frida mock works,
 * and the type contracts are coherent.
 *
 * Wave 0 owns this file. Wave 1+ test files live in tests/<subsystem>/
 * and src/**.test.ts (Vitest finds both).
 */

import { describe, it, expect, vi } from 'vitest';
import {
    EventBus,
    formatEvent,
    RosettaError,
    ResolveError,
    AmbiguousOverloadError,
    MapValidationError,
    JsonParseError,
    MapVersionMismatchError,
    HealthCheckFailedError,
    MarkerBlockError,
    UnresolvedAccessError,
    type RosettaMap,
    type DiagnosticEvent,
} from '../src/index.js';
import { MockFrida, installFridaMock, resetFridaMock, useFridaMock } from './mocks/index.js';

describe('error hierarchy', () => {
    it('RosettaError carries a name matching its class', () => {
        const err = new RosettaError('generic');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('RosettaError');
        expect(err.message).toBe('generic');
    });

    it('ResolveError preserves all context', () => {
        const err = new ResolveError(
            'no entry',
            'IFoo',
            'com.example.app',
            '1.2.3',
            'class',
            'IBar',
        );
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('ResolveError');
        expect(err.realName).toBe('IFoo');
        expect(err.app).toBe('com.example.app');
        expect(err.version).toBe('1.2.3');
        expect(err.kind).toBe('class');
        expect(err.classScope).toBe('IBar');
    });

    it('AmbiguousOverloadError preserves all context', () => {
        const err = new AmbiguousOverloadError('ambig', 'requestTicket', 'IFoo$Stub', 3);
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('AmbiguousOverloadError');
        expect(err.realName).toBe('requestTicket');
        expect(err.classScope).toBe('IFoo$Stub');
        expect(err.overloadCount).toBe(3);
    });

    it('MapValidationError preserves issues', () => {
        const issues = [{ path: 'classes.foo', message: 'missing obfuscated' }];
        const err = new MapValidationError('invalid map', issues);
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('MapValidationError');
        expect(err.issues).toEqual(issues);
    });

    it('JsonParseError carries position info', () => {
        const err = new JsonParseError('unexpected token', 12, 34);
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('JsonParseError');
        expect(err.line).toBe(12);
        expect(err.column).toBe(34);
    });

    it('MapVersionMismatchError carries detected and map versions', () => {
        const err = new MapVersionMismatchError(
            'mismatch',
            'com.example.app',
            '1.3.0',
            'com.example.app',
            '1.2.0',
        );
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('MapVersionMismatchError');
        expect(err.detectedApp).toBe('com.example.app');
        expect(err.detectedVersion).toBe('1.3.0');
        expect(err.mapApp).toBe('com.example.app');
        expect(err.mapVersion).toBe('1.2.0');
    });

    it('HealthCheckFailedError carries rate and failures', () => {
        const err = new HealthCheckFailedError('check failed', 0.5, 0.8, ['IFoo', 'IBar']);
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('HealthCheckFailedError');
        expect(err.rate).toBe(0.5);
        expect(err.threshold).toBe(0.8);
        expect(err.failedEntries).toEqual(['IFoo', 'IBar']);
    });

    it('MarkerBlockError can carry an optional bundle path', () => {
        const err = new MarkerBlockError('no marker', '/path/to/bundle.js');
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('MarkerBlockError');
        expect(err.bundlePath).toBe('/path/to/bundle.js');

        const err2 = new MarkerBlockError('no marker');
        expect(err2.bundlePath).toBeUndefined();
    });

    it('UnresolvedAccessError preserves the unresolved name', () => {
        const err = new UnresolvedAccessError('cannot use', 'IFoo');
        expect(err).toBeInstanceOf(RosettaError);
        expect(err.name).toBe('UnresolvedAccessError');
        expect(err.realName).toBe('IFoo');
    });
});

describe('EventBus', () => {
    it('delivers events to subscribers and unsubscribes cleanly', () => {
        const bus = new EventBus();
        const events: DiagnosticEvent[] = [];
        const off = bus.on((e) => events.push(e));

        bus.emit({ type: 'resolve', name: 'IFoo', obfName: 'aaaa', source: 'map' });
        bus.emit({ type: 'detect', app: 'com.example.app', version: '1.2.3', source: 'auto' });

        expect(events).toHaveLength(2);
        expect(events[0]?.type).toBe('resolve');
        expect(events[1]?.type).toBe('detect');

        off();
        bus.emit({ type: 'map-load', app: 'x', version: 'y', classCount: 1, schemaVersion: 1 });
        expect(events).toHaveLength(2);
    });

    it('onType filters by event type', () => {
        const bus = new EventBus();
        const resolves: DiagnosticEvent[] = [];
        const off = bus.onType('resolve', (e) => resolves.push(e));

        bus.emit({ type: 'resolve', name: 'A', source: 'map' });
        bus.emit({ type: 'detect', app: 'x', version: 'y', source: 'auto' });
        bus.emit({ type: 'resolve', name: 'B', source: 'cache' });

        expect(resolves).toHaveLength(2);
        expect((resolves[0] as { name: string }).name).toBe('A');
        expect((resolves[1] as { name: string }).name).toBe('B');

        off();
        bus.emit({ type: 'resolve', name: 'C', source: 'map' });
        expect(resolves).toHaveLength(2);
    });

    it('clear removes all subscribers', () => {
        const bus = new EventBus();
        const seen: number[] = [];
        bus.on(() => seen.push(1));
        bus.on(() => seen.push(2));
        bus.clear();
        bus.emit({ type: 'resolve', name: 'x', source: 'map' });
        expect(seen).toHaveLength(0);
    });

    it('trace mode writes formatted lines to stderr', () => {
        const bus = new EventBus();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        bus.setTrace(true);
        bus.emit({ type: 'resolve', name: 'IFoo', obfName: 'a', source: 'map' });
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]?.[0]).toMatch(/IFoo.*a.*map/);

        bus.setTrace(false);
        bus.emit({ type: 'resolve', name: 'IBar', source: 'map' });
        expect(spy).toHaveBeenCalledOnce(); // still 1 — trace off
        spy.mockRestore();
    });
});

describe('formatEvent', () => {
    it('formats a successful class resolve', () => {
        const s = formatEvent({ type: 'resolve', name: 'IFoo', obfName: 'aaaa', source: 'map' });
        expect(s).toMatch(/IFoo.*aaaa.*map/);
    });

    it('formats a resolve event with class scope and overload signature', () => {
        const s = formatEvent({
            type: 'resolve',
            name: 'requestTicket',
            obfName: 'c',
            source: 'cache',
            classScope: 'IFoo$Stub',
            overloadSignature: '(Bundle,IServiceCallback)',
        });
        expect(s).toMatch(/IFoo\$Stub\.requestTicket/);
        expect(s).toMatch(/cache/);
        expect(s).toMatch(/\(Bundle,IServiceCallback\)/);
    });

    it('formats a resolve event with no obfName (defaults to ?)', () => {
        const s = formatEvent({ type: 'resolve', name: 'IFoo', source: 'map' });
        expect(s).toMatch(/IFoo ← \?/);
    });

    it('formats a miss', () => {
        const s = formatEvent({ type: 'resolve', name: 'IBar', source: 'map', miss: true });
        expect(s).toMatch(/IBar.*MISS/);
    });

    it('formats a health-check pass', () => {
        const s = formatEvent({
            type: 'health-check',
            passed: true,
            rate: 0.92,
            failedEntries: [],
            threshold: 0.8,
        });
        expect(s).toMatch(/PASS/);
        expect(s).toMatch(/92\.0%/);
        expect(s).toMatch(/80\.0%/);
        expect(s).toMatch(/failures=0/);
    });

    it('formats a health-check fail', () => {
        const s = formatEvent({
            type: 'health-check',
            passed: false,
            rate: 0.4,
            failedEntries: ['IFoo', 'IBar'],
            threshold: 0.8,
        });
        expect(s).toMatch(/FAIL/);
        expect(s).toMatch(/failures=2/);
    });

    it('formats a detect event', () => {
        const s = formatEvent({
            type: 'detect',
            app: 'com.example.app',
            version: '1.2.3',
            source: 'auto',
        });
        expect(s).toMatch(/auto: com\.example\.app@1\.2\.3/);
    });

    it('formats a map-load event', () => {
        const s = formatEvent({
            type: 'map-load',
            app: 'com.example.app',
            version: '1.2.3',
            classCount: 47,
            schemaVersion: 1,
        });
        expect(s).toMatch(/classes=47/);
        expect(s).toMatch(/schema=1/);
    });

    it('formats a signer-check pass', () => {
        const s = formatEvent({
            type: 'signer-check',
            passed: true,
            app: 'com.example.app',
            expected: 'ab'.repeat(32),
            actual: ['ab'.repeat(32)],
            source: 'signingInfo',
        });
        expect(s).toMatch(/signer-check PASS com\.example\.app/);
        expect(s).toMatch(/signers=1/);
        expect(s).toMatch(/signingInfo/);
    });

    it('formats a signer-check fail', () => {
        const s = formatEvent({
            type: 'signer-check',
            passed: false,
            app: 'com.example.app',
            expected: 'cd'.repeat(32),
            actual: ['ab'.repeat(32), 'ef'.repeat(32)],
            source: 'signatures',
        });
        expect(s).toMatch(/signer-check FAIL/);
        expect(s).toMatch(/signers=2/);
        expect(s).toMatch(/signatures/);
    });
});

describe('RosettaMap type shape (compile-time)', () => {
    it('accepts a minimal well-formed map', () => {
        const map: RosettaMap = {
            schema_version: 5,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                'com.example.app.IRemoteService$Stub': {
                    obfuscated: 'aaaa',
                    kind: 'class',
                    methods: {
                        requestTicket: {
                            obfuscated: 'c',
                            signature: '(Landroid/os/Bundle;Lbbbb;)V',
                        },
                    },
                    fields: { sessionId: { obfuscated: 'a', type: 'Ljava/lang/String;' } },
                },
            },
        };
        expect(map.schema_version).toBe(5);
        expect(map.classes['com.example.app.IRemoteService$Stub']?.obfuscated).toBe('aaaa');
    });

    it('accepts overload-array form for methods', () => {
        const map: RosettaMap = {
            schema_version: 5,
            version_code: 1,
            app: 'com.example.app',
            version: '1.2.3',
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: {
                        bar: [
                            { obfuscated: 'c', signature: '()V' },
                            { obfuscated: 'd', signature: '(I)V' },
                        ],
                    },
                },
            },
        };
        const bar = map.classes.IFoo?.methods?.bar;
        expect(Array.isArray(bar)).toBe(true);
    });
});

describe('Frida mock', () => {
    useFridaMock();

    it('Java.use throws for unregistered classes', () => {
        expect(() => Java.use('not_registered')).toThrow(/not registered/);
    });

    it('returns a wrapper with method overloads', () => {
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
        const Klass = Java.use('aaaa');
        expect(Klass.$className).toBe('aaaa');

        const method = Klass.c as { overloads: { argumentTypes: { className: string }[] }[] };
        expect(method.overloads).toHaveLength(1);
        expect(method.overloads[0]?.argumentTypes[0]?.className).toBe('android.os.Bundle');
    });

    it('supports overload selection by arg types (string form)', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
                    {
                        argumentTypes: [{ className: 'android.os.Bundle' }, { className: 'bbbb' }],
                        returnType: { className: 'void' },
                    },
                    {
                        argumentTypes: [
                            { className: 'android.os.Bundle' },
                            { className: 'java.lang.String' },
                            { className: 'bbbb' },
                        ],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const Klass = Java.use('aaaa');
        const method = Klass.c as {
            overload: (...args: string[]) => { argumentTypes: { className: string }[] };
        };
        const picked = method.overload('android.os.Bundle', 'bbbb');
        expect(picked.argumentTypes).toHaveLength(2);

        expect(() => method.overload('android.os.Bundle')).toThrow(/no overload/);
    });

    it('supports overload selection by class wrapper', () => {
        MockFrida.registerClass('inner', {});
        MockFrida.registerClass('outer', {
            methods: {
                m: [
                    {
                        argumentTypes: [{ className: 'inner' }],
                        returnType: { className: 'void' },
                    },
                ],
            },
        });
        const Outer = Java.use('outer');
        const Inner = Java.use('inner');
        const method = Outer.m as {
            overload: (...args: unknown[]) => { argumentTypes: { className: string }[] };
        };
        const picked = method.overload(Inner);
        expect(picked.argumentTypes[0]?.className).toBe('inner');
    });

    it('installs implementations on overloads', () => {
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
        const Klass = Java.use('aaaa');
        const method = Klass.c as { implementation: ((b: unknown) => void) | null };
        let captured: unknown = null;
        method.implementation = (b) => {
            captured = b;
        };
        method.implementation?.('test-bundle');
        expect(captured).toBe('test-bundle');
    });

    it('throws if .implementation = is used on a method with multiple overloads', () => {
        MockFrida.registerClass('aaaa', {
            methods: {
                c: [
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
        const Klass = Java.use('aaaa');
        const method = Klass.c as { implementation: ((...a: unknown[]) => unknown) | null };
        expect(() => {
            method.implementation = () => null;
        }).toThrow(/multiple overloads/);
        expect(() => method.implementation).toThrow(/multiple overloads/);
    });

    it('supports static fields directly on the wrapper', () => {
        MockFrida.registerClass('aaaa', {
            fields: { S: { type: 'I', static: true, initial: 42 } },
        });
        const Klass = Java.use('aaaa');
        const field = Klass.S as { value: number };
        expect(field.value).toBe(42);
        field.value = 99;
        expect(field.value).toBe(99);
    });

    it('supports instance fields after $new', () => {
        MockFrida.registerClass('aaaa', {
            fields: { f: { type: 'Ljava/lang/String;', initial: 'hello' } },
        });
        const Klass = Java.use('aaaa');
        const inst = Klass.$new();
        const field = inst.f as { value: string };
        expect(field.value).toBe('hello');
        field.value = 'world';
        expect(field.value).toBe('world');
    });

    it('walks the superclass hierarchy', () => {
        MockFrida.registerClass('grand', {});
        MockFrida.registerClass('parent', { superclass: 'grand' });
        MockFrida.registerClass('child', { superclass: 'parent' });

        const Klass = Java.use('child');
        expect(Klass.$super).toBe('parent');
        expect(Klass.$superHierarchy).toEqual(['parent', 'grand']);
    });

    it('class.getName / getSuperclass / getInterfaces work', () => {
        MockFrida.registerClass('iface', {});
        MockFrida.registerClass('parent', {});
        MockFrida.registerClass('child', { superclass: 'parent', interfaces: ['iface'] });
        const Klass = Java.use('child');
        expect(Klass.class.getName()).toBe('child');
        expect(Klass.class.getSuperclass()?.$className).toBe('parent');
        expect(Klass.class.getInterfaces()[0]?.$className).toBe('iface');

        // Root class has no superclass.
        const Parent = Java.use('parent');
        expect(Parent.class.getSuperclass()).toBeNull();
        expect(Parent.class.getInterfaces()).toEqual([]);
    });

    it('Java.enumerateLoadedClasses iterates registered classes', () => {
        MockFrida.registerClass('aaaa', {});
        MockFrida.registerClass('bbbb', {});
        const matches: string[] = [];
        let completed = false;
        Java.enumerateLoadedClasses({
            onMatch: (n) => matches.push(n),
            onComplete: () => {
                completed = true;
            },
        });
        expect(matches).toContain('aaaa');
        expect(matches).toContain('bbbb');
        expect(completed).toBe(true);
    });

    it('Java.enumerateLoadedClasses tolerates absent onComplete', () => {
        MockFrida.registerClass('aaaa', {});
        const matches: string[] = [];
        Java.enumerateLoadedClasses({
            onMatch: (n) => matches.push(n),
        });
        expect(matches).toContain('aaaa');
    });

    it('Java.cast returns the original instance', () => {
        MockFrida.registerClass('aaaa', {});
        const Klass = Java.use('aaaa');
        const inst = Klass.$new();
        const cast = Java.cast(inst, Klass);
        expect(cast).toBe(inst);
    });

    it('Java.perform invokes its callback synchronously', () => {
        let called = false;
        Java.perform(() => {
            called = true;
        });
        expect(called).toBe(true);
    });

    it('global Frida / Process / send are present while installed', () => {
        expect(Frida.version).toBe('17.0.0-mock');
        expect(Process.arch).toBe('arm64');
        expect(typeof send).toBe('function');
    });

    it('MockFrida.has reports registration status', () => {
        MockFrida.registerClass('aaaa', {});
        expect(MockFrida.has('aaaa')).toBe(true);
        expect(MockFrida.has('bbbb')).toBe(false);
    });
});

describe('Frida mock install/reset isolation', () => {
    it('throws when installed twice without resetting', () => {
        installFridaMock();
        expect(() => installFridaMock()).toThrow(/already installed/);
        resetFridaMock();
    });

    it('reset is safe to call when not installed', () => {
        expect(() => resetFridaMock()).not.toThrow();
    });
});
