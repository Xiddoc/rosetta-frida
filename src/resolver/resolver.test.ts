/**
 * Tests for the concrete Resolver implementation and the sentinel-aware
 * wrappers. Aims at full line/branch/function/statement coverage.
 *
 * Examples use only generic placeholder names — no real-app identifiers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    AmbiguousOverloadError,
    ResolveError,
    TargetPolicyError,
    UnknownArgTypeError,
    UnresolvedAccessError,
} from '../errors.js';
import { EventBus } from '../diagnostics/event-bus.js';
import type { ClassEntry, RosettaMap } from '../types/map.js';
import type { ResolveEvent } from '../types/events.js';
import {
    ResolverImpl,
    resolveClassOrSentinel,
    resolveFieldOrSentinel,
    resolveMethodOrSentinel,
} from './resolver.js';
import { createResolver } from './index.js';
import { isSentinel, SENTINEL_REAL_NAME } from './sentinel.js';
import { validateMap } from '../validate/schema.js';

// The resolver consumes the NORMALISED in-memory map (methods always
// arrays). Fixtures here are authored in the terser single-overload form
// and run through validateMap so the resolver sees the normalised shape —
// exactly as production does.
function buildMap(): RosettaMap {
    return {
        schema_version: 2,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {
            'com.example.app.IRemoteService$Stub': {
                obfuscated: 'aaaa',
                kind: 'aidl_stub',
                methods: {
                    // Single-overload form.
                    init: {
                        obfuscated: 'a',
                        signature: '()V',
                        is_constructor: true,
                    },
                    // Multi-overload form.
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
                            static: true,
                        },
                    ],
                },
                fields: {
                    sessionId: { obfuscated: 'a', type: 'Ljava/lang/String;' },
                    STATIC_FIELD: { obfuscated: 'b', type: 'I', static: true },
                },
            },
            IServiceCallback: {
                obfuscated: 'bbbb',
                kind: 'aidl_callback',
            },
            'com.example.app.PlainClass': {
                obfuscated: 'cccc',
                methods: {
                    onlyOverload: {
                        obfuscated: 'm',
                        signature: '(I)V',
                    },
                },
            },
        },
    };
}

interface Harness {
    map: RosettaMap;
    bus: EventBus;
    events: ResolveEvent[];
    resolver: ResolverImpl;
}

function makeHarness(overrides?: { map?: RosettaMap }): Harness {
    // Normalise through the real validator so methods are always arrays.
    const map = validateMap(overrides?.map ?? buildMap());
    const bus = new EventBus();
    const events: ResolveEvent[] = [];
    bus.onType('resolve', (e) => events.push(e));
    const resolver = new ResolverImpl({ map, events: bus });
    return { map, bus, events, resolver };
}

describe('ResolverImpl.resolveClass', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('resolves a known class through the map and emits an event', () => {
        const r = h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(r.realName).toBe('com.example.app.IRemoteService$Stub');
        expect(r.obfName).toBe('aaaa');
        expect(r.entry.kind).toBe('aidl_stub');
        const last = h.events.at(-1);
        expect(last).toMatchObject({ source: 'map', obfName: 'aaaa' });
    });

    it('returns the cache on the second access', () => {
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        h.events.length = 0;
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.source).toBe('cache');
    });

    it('throws ResolveError under default policy for an unmapped class', () => {
        try {
            h.resolver.resolveClass('com.example.app.IMissing');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            const err = e as ResolveError;
            expect(err.realName).toBe('com.example.app.IMissing');
            expect(err.kind).toBe('class');
            expect(err.app).toBe('com.example.app');
            expect(err.version).toBe('1.2.3');
            expect(err.classScope).toBeUndefined();
            expect(err.message).toMatch(/com\.example\.app@1\.2\.3/);
        }
        // Miss event is still emitted.
        const miss = h.events.find((e) => e.miss);
        expect(miss).toBeDefined();
    });

    it('hasClass reports map membership', () => {
        expect(h.resolver.hasClass('com.example.app.IRemoteService$Stub')).toBe(true);
        expect(h.resolver.hasClass('com.example.app.IMissing')).toBe(false);
    });

    it('hasClass returns true for an overridden class not in the original map', () => {
        expect(h.resolver.hasClass('com.example.app.NewClass')).toBe(false);
        h.resolver.override('com.example.app.NewClass', { obfuscated: 'xxxx' });
        expect(h.resolver.hasClass('com.example.app.NewClass')).toBe(true);
    });
});

describe('ResolverImpl.resolveMethod', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('resolves a single-overload method without argTypes', () => {
        const m = h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'init');
        expect(m.realName).toBe('init');
        expect(m.obfName).toBe('a');
        expect(m.className).toBe('aaaa');
        expect(m.signature).toBe('()V');
        expect(m.allOverloads).toHaveLength(1);
        expect(m.static).toBe(false);
    });

    it('resolves a single overload (object-form) with matching argTypes', () => {
        const m = h.resolver.resolveMethod('com.example.app.PlainClass', 'onlyOverload', ['int']);
        expect(m.obfName).toBe('m');
        expect(m.signature).toBe('(I)V');
    });

    it('disambiguates multiple overloads by matching argTypes (first overload)', () => {
        const m = h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
            'android.os.Bundle',
            'IServiceCallback',
        ]);
        expect(m.obfName).toBe('c');
        expect(m.aidlTxn).toBe(2);
        expect(m.signature).toBe('(Landroid/os/Bundle;Lbbbb;)V');
        expect(m.static).toBe(false);
        expect(m.allOverloads).toHaveLength(2);
        // Selected overload sits at [0] for downstream consumers.
        expect(m.allOverloads[0]?.obfuscated).toBe('c');
    });

    it('disambiguates multiple overloads by matching argTypes (second overload)', () => {
        const m = h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
            'android.os.Bundle',
            'java.lang.String',
            'IServiceCallback',
        ]);
        expect(m.obfName).toBe('d');
        expect(m.aidlTxn).toBe(4);
        expect(m.static).toBe(true);
        expect(m.allOverloads[0]?.obfuscated).toBe('d');
    });

    it('throws AmbiguousOverloadError when no argTypes are given and multiple overloads exist', () => {
        try {
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(AmbiguousOverloadError);
            const err = e as AmbiguousOverloadError;
            expect(err.realName).toBe('requestTicket');
            expect(err.classScope).toBe('com.example.app.IRemoteService$Stub');
            expect(err.overloadCount).toBe(2);
        }
    });

    it('throws ResolveError when argTypes do not match any overload (wrong arity)', () => {
        try {
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
                'android.os.Bundle',
            ]);
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            const err = e as ResolveError;
            expect(err.kind).toBe('method');
            expect(err.classScope).toBe('com.example.app.IRemoteService$Stub');
            expect(err.message).toMatch(/no overload/);
        }
        expect(h.events.some((e) => e.miss)).toBe(true);
    });

    it('throws ResolveError when argTypes do not match any overload (right arity, wrong type)', () => {
        try {
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
                'android.os.Bundle',
                'java.lang.String',
            ]);
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
        }
    });

    it('throws UnknownArgTypeError when an overload arg type is an unmapped class', () => {
        try {
            // Right arity (2 args) but the 2nd arg type is a dotted class name
            // the map does not know AND no overload declares its descriptor —
            // the precise unknown-arg-type case, mirroring the Kotlin twin.
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
                'android.os.Bundle',
                'com.example.app.NotInMap',
            ]);
            expect.fail('expected throw');
        } catch (e) {
            // It IS a ResolveError subtype, so generic handlers still catch it,
            // but it carries the distinct identity + offending arg type.
            expect(e).toBeInstanceOf(ResolveError);
            expect(e).toBeInstanceOf(UnknownArgTypeError);
            const err = e as UnknownArgTypeError;
            expect(err.kind).toBe('method');
            expect(err.classScope).toBe('com.example.app.IRemoteService$Stub');
            expect(err.argType).toBe('com.example.app.NotInMap');
            expect(err.message).toMatch(/not a known class/);
        }
        expect(h.events.some((e) => e.miss)).toBe(true);
    });

    it('throws the generic ResolveError (not UnknownArgType) when arg types are all known but no overload matches', () => {
        // Both arg types ARE known map classes / declared descriptors, so this
        // is a legitimate no-overload-matches miss, not an unmapped arg type.
        try {
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
                'IServiceCallback',
            ]);
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            expect(e).not.toBeInstanceOf(UnknownArgTypeError);
            expect((e as ResolveError).message).toMatch(/no overload/);
        }
    });

    it('throws ResolveError when the method real-name is not in the map', () => {
        try {
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'doesNotExist');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            const err = e as ResolveError;
            expect(err.kind).toBe('method');
            expect(err.classScope).toBe('com.example.app.IRemoteService$Stub');
        }
        expect(h.events.some((e) => e.miss && e.name === 'doesNotExist')).toBe(true);
    });

    it('throws ResolveError when the class has no methods at all', () => {
        const map = buildMap();
        // IServiceCallback has no `methods` key.
        const h2 = makeHarness({ map });
        try {
            h2.resolver.resolveMethod('IServiceCallback', 'whatever');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
        }
    });

    it('caches method resolutions per (class, method, argTypes)', () => {
        h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
            'android.os.Bundle',
            'IServiceCallback',
        ]);
        h.events.length = 0;
        h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket', [
            'android.os.Bundle',
            'IServiceCallback',
        ]);
        // Only one cache event (no class re-resolve required either).
        expect(h.events).toHaveLength(1);
        expect(h.events[0]).toMatchObject({
            source: 'cache',
            classScope: 'com.example.app.IRemoteService$Stub',
        });
    });
});

describe('ResolverImpl.resolveField', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('resolves an instance field', () => {
        const f = h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        expect(f.obfName).toBe('a');
        expect(f.className).toBe('aaaa');
        expect(f.type).toBe('Ljava/lang/String;');
        expect(f.static).toBe(false);
    });

    it('resolves a static field', () => {
        const f = h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'STATIC_FIELD');
        expect(f.obfName).toBe('b');
        expect(f.static).toBe(true);
    });

    it('caches field resolutions', () => {
        h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        h.events.length = 0;
        h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.source).toBe('cache');
    });

    it('throws ResolveError when the field is not in the map', () => {
        try {
            h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'missing');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
            const err = e as ResolveError;
            expect(err.kind).toBe('field');
            expect(err.classScope).toBe('com.example.app.IRemoteService$Stub');
        }
        expect(h.events.some((e) => e.miss && e.name === 'missing')).toBe(true);
    });

    it('throws ResolveError when the class has no fields', () => {
        try {
            h.resolver.resolveField('IServiceCallback', 'whatever');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(ResolveError);
        }
    });
});

describe('ResolverImpl.translateType', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('translates a real-name class to its obfuscated name', () => {
        expect(h.resolver.translateType('IServiceCallback')).toBe('bbbb');
    });

    it('passes primitives through verbatim', () => {
        expect(h.resolver.translateType('int')).toBe('int');
        expect(h.resolver.translateType('boolean')).toBe('boolean');
    });

    it('passes framework types through verbatim', () => {
        expect(h.resolver.translateType('android.os.Bundle')).toBe('android.os.Bundle');
    });

    it('passes unmapped class names through verbatim', () => {
        expect(h.resolver.translateType('com.example.unknown.Type')).toBe(
            'com.example.unknown.Type',
        );
    });

    it('honours overrides when translating', () => {
        const override: ClassEntry = { obfuscated: 'override-obf' };
        h.resolver.override('IServiceCallback', override);
        expect(h.resolver.translateType('IServiceCallback')).toBe('override-obf');
    });
});

describe('ResolverImpl.override', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('replaces the map entry on the next resolve and emits source: override', () => {
        const entry: ClassEntry = { obfuscated: 'overridden', kind: 'class' };
        h.resolver.override('com.example.app.IRemoteService$Stub', entry);
        h.events.length = 0;
        const r = h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(r.obfName).toBe('overridden');
        const last = h.events.at(-1);
        expect(last?.source).toBe('override');
    });

    it('makes a previously-unknown class resolvable', () => {
        const entry: ClassEntry = { obfuscated: 'fresh' };
        h.resolver.override('com.example.app.IFresh', entry);
        const r = h.resolver.resolveClass('com.example.app.IFresh');
        expect(r.obfName).toBe('fresh');
    });

    it('invalidates a previously-cached resolution so the override takes effect', () => {
        const first = h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(first.obfName).toBe('aaaa');
        h.resolver.override('com.example.app.IRemoteService$Stub', { obfuscated: 'zzzz' });
        const second = h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(second.obfName).toBe('zzzz');
    });

    it('lookupField sees override-supplied fields', () => {
        h.resolver.override('com.example.app.IOverride', {
            obfuscated: 'overOb',
            fields: { x: { obfuscated: 'o', type: 'I' } },
        });
        const f = h.resolver.lookupField('com.example.app.IOverride', 'x');
        expect(f?.obfuscated).toBe('o');
    });

    it('advances the cache epoch so live consumers can detect staleness', () => {
        const before = h.resolver.cacheEpoch();
        h.resolver.override('com.example.app.IRemoteService$Stub', { obfuscated: 'zzzz' });
        const after = h.resolver.cacheEpoch();
        expect(after).not.toBe(before);
    });
});

describe('ResolverImpl.cacheEpoch', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('is stable across plain resolves and advances on invalidate', () => {
        const start = h.resolver.cacheEpoch();
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        // Reads alone never move the epoch.
        expect(h.resolver.cacheEpoch()).toBe(start);
        h.resolver.invalidate('com.example.app.IRemoteService$Stub');
        expect(h.resolver.cacheEpoch()).toBe(start + 1);
    });
});

describe('ResolverImpl.invalidate', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('clears a cached class so the next resolve hits map again', () => {
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        h.resolver.invalidate('com.example.app.IRemoteService$Stub');
        h.events.length = 0;
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        expect(h.events[0]?.source).toBe('map');
    });

    it('clears cached methods scoped to the invalidated class', () => {
        h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'init');
        h.resolver.invalidate('com.example.app.IRemoteService$Stub');
        h.events.length = 0;
        h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'init');
        // First event is the (re-)cached class lookup (source=map),
        // second is the method itself (source=map). No cache events.
        expect(h.events.every((e) => e.source !== 'cache')).toBe(true);
    });

    it('clears cached fields scoped to the invalidated class', () => {
        h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        h.resolver.invalidate('com.example.app.IRemoteService$Stub');
        h.events.length = 0;
        h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        expect(h.events.every((e) => e.source !== 'cache')).toBe(true);
    });

    it('does not clear caches scoped to other classes', () => {
        h.resolver.resolveClass('com.example.app.PlainClass');
        h.resolver.invalidate('com.example.app.IRemoteService$Stub');
        h.events.length = 0;
        h.resolver.resolveClass('com.example.app.PlainClass');
        expect(h.events[0]?.source).toBe('cache');
    });
});

describe('ResolverImpl.lookupField', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('returns the entry for a known field', () => {
        const f = h.resolver.lookupField('com.example.app.IRemoteService$Stub', 'sessionId');
        expect(f?.obfuscated).toBe('a');
    });

    it('returns undefined for an unknown field', () => {
        const f = h.resolver.lookupField('com.example.app.IRemoteService$Stub', 'missing');
        expect(f).toBeUndefined();
    });

    it('returns undefined for an unknown class', () => {
        const f = h.resolver.lookupField('com.example.app.IMissing', 'sessionId');
        expect(f).toBeUndefined();
    });
});

describe('ResolverImpl.reverseLookup', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('maps an obfuscated class name back to its real FQN', () => {
        expect(h.resolver.reverseLookup('aaaa')).toBe('com.example.app.IRemoteService$Stub');
        expect(h.resolver.reverseLookup('bbbb')).toBe('IServiceCallback');
    });

    it('returns undefined for an unmapped obf name', () => {
        expect(h.resolver.reverseLookup('zzzz')).toBeUndefined();
    });

    it('reflects overrides in the reverse index', () => {
        h.resolver.override('com.example.app.IFresh', { obfuscated: 'fff' });
        expect(h.resolver.reverseLookup('fff')).toBe('com.example.app.IFresh');
    });

    it('is FIRST-WINS when two classes share an obfuscated name (cross-client policy)', () => {
        // A malformed map can map two real classes onto the same obfuscated
        // short name. The reverse index must keep the FIRST in iteration order,
        // matching the Kotlin twin's putIfAbsent. (Object.entries preserves
        // insertion order for string keys, so 'com.example.app.First' wins.)
        const map = validateMap({
            schema_version: 2,
            version_code: 1,
            app: 'com.example.app',
            version: '1.0.0',
            classes: {
                'com.example.app.First': { obfuscated: 'dup' },
                'com.example.app.Second': { obfuscated: 'dup' },
            },
        });
        const resolver = new ResolverImpl({ map, events: new EventBus() });
        expect(resolver.reverseLookup('dup')).toBe('com.example.app.First');
    });
});

describe('ResolverImpl miss-message wording (cross-client canonical)', () => {
    let h: Harness;
    beforeEach(() => {
        h = makeHarness();
    });

    it('class miss reads "class \'<name>\' not found"', () => {
        expect(() => h.resolver.resolveClass('com.example.app.Missing')).toThrow(
            "rosetta-frida: class 'com.example.app.Missing' not found in map for com.example.app@1.2.3.",
        );
    });

    it("method miss reads \"method '<name>' not found on class '<class>'\"", () => {
        expect(() =>
            h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'noSuchMethod'),
        ).toThrow(
            "rosetta-frida: method 'noSuchMethod' not found on class 'com.example.app.IRemoteService$Stub' in map for com.example.app@1.2.3.",
        );
    });

    it("field miss reads \"field '<name>' not found on class '<class>'\"", () => {
        expect(() =>
            h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'noSuchField'),
        ).toThrow(
            "rosetta-frida: field 'noSuchField' not found on class 'com.example.app.IRemoteService$Stub' in map for com.example.app@1.2.3.",
        );
    });
});

describe('Resolver event-emission shapes', () => {
    it('emits classScope on method events but not on class events', () => {
        const h = makeHarness();
        h.resolver.resolveClass('com.example.app.IRemoteService$Stub');
        h.resolver.resolveMethod('com.example.app.IRemoteService$Stub', 'init');
        const classEvt = h.events.find((e) => e.name === 'com.example.app.IRemoteService$Stub');
        const methodEvt = h.events.find((e) => e.name === 'init');
        expect(classEvt?.classScope).toBeUndefined();
        expect(methodEvt?.classScope).toBe('com.example.app.IRemoteService$Stub');
        expect(methodEvt?.overloadSignature).toBe('()V');
    });

    it('emits classScope on field events too', () => {
        const h = makeHarness();
        h.resolver.resolveField('com.example.app.IRemoteService$Stub', 'sessionId');
        const fieldEvt = h.events.find((e) => e.name === 'sessionId');
        expect(fieldEvt?.classScope).toBe('com.example.app.IRemoteService$Stub');
    });

    it('trace mode writes events to stderr (console.error)', () => {
        const bus = new EventBus();
        const calls: string[] = [];
        const original = console.error;
        console.error = (msg: unknown): void => {
            calls.push(String(msg));
        };
        try {
            bus.setTrace(true);
            const resolver = new ResolverImpl({ map: validateMap(buildMap()), events: bus });
            resolver.resolveClass('com.example.app.IRemoteService$Stub');
        } finally {
            console.error = original;
        }
        expect(calls.some((c) => c.includes('com.example.app.IRemoteService$Stub'))).toBe(true);
        expect(calls.some((c) => c.includes('aaaa'))).toBe(true);
    });
});

describe('createResolver factory', () => {
    it('returns a Resolver backed by a fresh EventBus when none is supplied', () => {
        const map = validateMap(buildMap());
        const r = createResolver(map);
        const cls = r.resolveClass('com.example.app.IRemoteService$Stub');
        expect(cls.obfName).toBe('aaaa');
    });

    it('uses a caller-supplied EventBus and respects the failurePolicy option', () => {
        const map = validateMap(buildMap());
        const bus = new EventBus();
        const events: ResolveEvent[] = [];
        bus.onType('resolve', (e) => events.push(e));
        const r = createResolver(map, { events: bus, failurePolicy: 'warn' });
        r.resolveClass('com.example.app.IRemoteService$Stub');
        expect(events).toHaveLength(1);
    });
});

describe('sentinel-aware wrappers', () => {
    it('resolveClassOrSentinel returns the resolved class on hit', () => {
        const h = makeHarness();
        const r = resolveClassOrSentinel(
            h.resolver,
            'com.example.app.IRemoteService$Stub',
            'strict',
        );
        expect(isSentinel(r)).toBe(false);
        expect((r as { obfName: string }).obfName).toBe('aaaa');
    });

    it('resolveClassOrSentinel returns a sentinel under warn policy on miss', () => {
        const h = makeHarness();
        const r = resolveClassOrSentinel(h.resolver, 'com.example.app.IMissing', 'warn');
        expect(isSentinel(r)).toBe(true);
        expect((r as { [SENTINEL_REAL_NAME]: string })[SENTINEL_REAL_NAME]).toBe(
            'com.example.app.IMissing',
        );
        expect(() => (r as { x: unknown }).x).toThrow(UnresolvedAccessError);
    });

    it('resolveClassOrSentinel re-throws ResolveError under strict policy', () => {
        const h = makeHarness();
        expect(() =>
            resolveClassOrSentinel(h.resolver, 'com.example.app.IMissing', 'strict'),
        ).toThrow(ResolveError);
    });

    it('resolveClassOrSentinel re-throws non-ResolveError exceptions under warn', () => {
        const stubResolver = {
            resolveClass(): never {
                throw new Error('not a resolve error');
            },
        } as unknown as ResolverImpl;
        expect(() => resolveClassOrSentinel(stubResolver, 'X', 'warn')).toThrow(
            /not a resolve error/,
        );
    });

    it('resolveMethodOrSentinel returns the method on hit', () => {
        const h = makeHarness();
        const m = resolveMethodOrSentinel(
            h.resolver,
            'com.example.app.IRemoteService$Stub',
            'init',
            undefined,
            'strict',
        );
        expect(isSentinel(m)).toBe(false);
        expect((m as { obfName: string }).obfName).toBe('a');
    });

    it('resolveMethodOrSentinel returns a sentinel on miss under warn', () => {
        const h = makeHarness();
        const m = resolveMethodOrSentinel(
            h.resolver,
            'com.example.app.IRemoteService$Stub',
            'missingMethod',
            undefined,
            'warn',
        );
        expect(isSentinel(m)).toBe(true);
        expect((m as { [SENTINEL_REAL_NAME]: string })[SENTINEL_REAL_NAME]).toBe(
            'com.example.app.IRemoteService$Stub.missingMethod',
        );
    });

    it('resolveMethodOrSentinel re-throws AmbiguousOverloadError even under warn', () => {
        const h = makeHarness();
        expect(() =>
            resolveMethodOrSentinel(
                h.resolver,
                'com.example.app.IRemoteService$Stub',
                'requestTicket',
                undefined,
                'warn',
            ),
        ).toThrow(AmbiguousOverloadError);
    });

    it('resolveMethodOrSentinel re-throws ResolveError under strict', () => {
        const h = makeHarness();
        expect(() =>
            resolveMethodOrSentinel(
                h.resolver,
                'com.example.app.IRemoteService$Stub',
                'doesNotExist',
                undefined,
                'strict',
            ),
        ).toThrow(ResolveError);
    });

    it('resolveFieldOrSentinel returns the field on hit', () => {
        const h = makeHarness();
        const f = resolveFieldOrSentinel(
            h.resolver,
            'com.example.app.IRemoteService$Stub',
            'sessionId',
            'strict',
        );
        expect(isSentinel(f)).toBe(false);
        expect((f as { obfName: string }).obfName).toBe('a');
    });

    it('resolveFieldOrSentinel returns a sentinel on miss under warn', () => {
        const h = makeHarness();
        const f = resolveFieldOrSentinel(
            h.resolver,
            'com.example.app.IRemoteService$Stub',
            'missing',
            'warn',
        );
        expect(isSentinel(f)).toBe(true);
    });

    it('resolveFieldOrSentinel re-throws ResolveError under strict', () => {
        const h = makeHarness();
        expect(() =>
            resolveFieldOrSentinel(
                h.resolver,
                'com.example.app.IRemoteService$Stub',
                'missing',
                'strict',
            ),
        ).toThrow(ResolveError);
    });

    it('resolveFieldOrSentinel re-throws non-ResolveError exceptions under warn', () => {
        const stubResolver = {
            resolveField(): never {
                throw new Error('not a resolve error');
            },
        } as unknown as ResolverImpl;
        expect(() => resolveFieldOrSentinel(stubResolver, 'X', 'y', 'warn')).toThrow(
            /not a resolve error/,
        );
    });

    it('resolveMethodOrSentinel re-throws non-ResolveError exceptions under warn', () => {
        const stubResolver = {
            resolveMethod(): never {
                throw new Error('not a resolve error');
            },
        } as unknown as ResolverImpl;
        expect(() => resolveMethodOrSentinel(stubResolver, 'X', 'y', undefined, 'warn')).toThrow(
            /not a resolve error/,
        );
    });
});

describe('ResolverImpl — target-namespace guard (RFC 0001 C1)', () => {
    /** A map whose obfuscated targets point at framework classes. */
    function maliciousMap(): RosettaMap {
        return {
            schema_version: 2,
            version_code: 1,
            app: 'com.example.app',
            version: '1.0.0',
            classes: {
                'com.example.app.Evil': { obfuscated: 'java.lang.Runtime' },
                'com.example.app.EvilMethod': {
                    obfuscated: 'android.app.ActivityThread',
                    methods: { go: { obfuscated: 'm', signature: '()V' } },
                },
                'com.example.app.EvilField': {
                    obfuscated: 'dalvik.system.DexClassLoader',
                    fields: { f: { obfuscated: 'a', type: 'I' } },
                },
                'com.example.app.Good': {
                    obfuscated: 'aaaa',
                    methods: { ok: { obfuscated: 'c', signature: '()V' } },
                    fields: { g: { obfuscated: 'b', type: 'I' } },
                },
                // Arg-type secondary vector: a "callback" real type whose obf
                // name is a framework class.
                EvilCallback: { obfuscated: 'kotlin.Unit' },
                GoodCallback: { obfuscated: 'bbbb' },
            },
        };
    }

    function harness(map: RosettaMap): { resolver: ResolverImpl; events: ResolveEvent[] } {
        const bus = new EventBus();
        const events: ResolveEvent[] = [];
        bus.onType('resolve', (e) => events.push(e));
        const resolver = new ResolverImpl({ map: validateMap(map), events: bus });
        return { resolver, events };
    }

    it('rejects a map redirecting a class at java.lang.Runtime (default fail-closed)', () => {
        const { resolver } = harness(maliciousMap());
        try {
            resolver.resolveClass('com.example.app.Evil');
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(TargetPolicyError);
            const err = e as TargetPolicyError;
            expect(err.realName).toBe('com.example.app.Evil');
            expect(err.target).toBe('java.lang.Runtime');
            expect(err.reason).toBe('reserved-namespace');
        }
    });

    it('does NOT cache a denied class (no cache poisoning)', () => {
        const { resolver, events } = harness(maliciousMap());
        expect(() => resolver.resolveClass('com.example.app.Evil')).toThrow(TargetPolicyError);
        // Second attempt must re-evaluate (and re-throw), not return a cache.
        expect(() => resolver.resolveClass('com.example.app.Evil')).toThrow(TargetPolicyError);
        // No 'cache'-sourced resolve event was ever emitted for it.
        expect(events.some((e) => e.source === 'cache')).toBe(false);
    });

    it('rejects via resolveMethod when the owning class target is forbidden', () => {
        const { resolver } = harness(maliciousMap());
        expect(() => resolver.resolveMethod('com.example.app.EvilMethod', 'go')).toThrow(
            TargetPolicyError,
        );
    });

    it('rejects via resolveField when the owning class target is forbidden', () => {
        const { resolver } = harness(maliciousMap());
        expect(() => resolver.resolveField('com.example.app.EvilField', 'f')).toThrow(
            TargetPolicyError,
        );
    });

    it('allows package-local and app-prefixed targets', () => {
        const { resolver } = harness(maliciousMap());
        expect(resolver.resolveClass('com.example.app.Good').obfName).toBe('aaaa');
        expect(resolver.resolveMethod('com.example.app.Good', 'ok').obfName).toBe('c');
        expect(resolver.resolveField('com.example.app.Good', 'g').obfName).toBe('b');
    });

    it('guards translateType mapped output (arg-type secondary vector)', () => {
        const { resolver } = harness(maliciousMap());
        expect(() => resolver.translateType('EvilCallback')).toThrow(TargetPolicyError);
        // Good callback still translates.
        expect(resolver.translateType('GoodCallback')).toBe('bbbb');
        // Unmapped passthrough is untouched (caller's own input, not map-controlled).
        expect(resolver.translateType('android.os.Bundle')).toBe('android.os.Bundle');
    });

    it('guards an override that points at a framework class', () => {
        const { resolver } = harness(maliciousMap());
        resolver.override('com.example.app.Hijack', { obfuscated: 'java.lang.System' });
        expect(() => resolver.resolveClass('com.example.app.Hijack')).toThrow(TargetPolicyError);
    });

    it('guards translateType through an override', () => {
        const { resolver } = harness(maliciousMap());
        resolver.override('com.example.app.HijackType', { obfuscated: 'javax.crypto.Cipher' });
        expect(() => resolver.translateType('com.example.app.HijackType')).toThrow(
            TargetPolicyError,
        );
    });

    it('an explicit allowlist permits an otherwise-forbidden framework target', () => {
        const bus = new EventBus();
        const resolver = new ResolverImpl({
            map: validateMap(maliciousMap()),
            events: bus,
            targetPolicy: { allow: ['java.lang.Runtime'] },
        });
        expect(resolver.resolveClass('com.example.app.Evil').obfName).toBe('java.lang.Runtime');
    });

    it('uses appPackage override to derive the app prefix when supplied', () => {
        const map: RosettaMap = {
            schema_version: 2,
            version_code: 1,
            app: 'com.example.app',
            version: '1.0.0',
            classes: {
                Foreign: { obfuscated: 'org.other.lib.Thing' },
            },
        };
        // With appPackage = org.other, the org.other.* target is app-owned.
        const bus = new EventBus();
        const resolver = new ResolverImpl({
            map: validateMap(map),
            events: bus,
            appPackage: 'org.other.app',
        });
        expect(resolver.resolveClass('Foreign').obfName).toBe('org.other.lib.Thing');
    });
});
