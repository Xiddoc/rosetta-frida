# Tier 3 — low-level / escape hatches

Pathological cases, debugging, and interop with hooks not authored
against rosetta-frida. Two surfaces:

- [`rosetta.map.*`](#rosettamap) — direct resolver queries and
  runtime overrides.
- [`rosetta.events.*`](#rosettaevents) — programmatic subscription
  to the session's diagnostic event bus.

Both surfaces are intentionally thin. They delegate to the underlying
Resolver and EventBus; the value is in being the documented escape
hatch when tier 1 and tier 2 don't fit.

## `rosetta.map`

The `rosetta.map` accessor returns a fresh `MapApi` bound to the
current ambient session each access — so switching sessions via
`rosetta.session(...)` also switches what `rosetta.map` returns.

### `MapApi` shape

```typescript
interface MapApi {
    resolveClass(realName: string): ResolvedClass;
    resolveMethod(
        className: string,
        methodName: string,
        argTypes?: readonly string[],
    ): ResolvedMethod;
    resolveField(className: string, fieldName: string): ResolvedField;
    override(realName: string, entry: ClassEntry): void;
    extract(): RosettaMap;
}
```

### `rosetta.map.resolveClass`

```typescript
const cls = rosetta.map.resolveClass('com.example.app.IRemoteService$Stub');
// → { realName: 'com.example.app.IRemoteService$Stub',
//     obfName: 'aaaa',
//     entry: { obfuscated: 'aaaa', kind: 'aidl_stub', methods: { ... }, ... } }
```

`ResolvedClass` carries the full `ClassEntry` from the map, so you
can introspect kind, AIDL descriptor, anchors, methods, fields, and
source provenance.

Useful for adaptive logic that branches on whether a real name is
in the map this release:

```typescript
let stubClass: ResolvedClass | null = null;
try {
    stubClass = rosetta.map.resolveClass('com.example.app.IRemoteService$Stub');
} catch (e) {
    if (e instanceof ResolveError) {
        send({ stage: 'stub-not-in-map', version: rosetta.map.extract().version });
    } else {
        throw e;
    }
}
```

### `rosetta.map.resolveMethod`

```typescript
const m = rosetta.map.resolveMethod(
    'com.example.app.IRemoteService$Stub',
    'requestTicket',
);
// → { realName: 'requestTicket',
//     obfName: 'c',
//     className: 'aaaa',
//     signature: '(Landroid/os/Bundle;Lbbbb;)V',
//     aidlTxn: 2,
//     static: false,
//     allOverloads: [ ... ] }
```

When `requestTicket` has multiple overloads in the map, pass
`argTypes` to disambiguate (real names + framework types, same rule
as tier 1's `args`):

```typescript
const m = rosetta.map.resolveMethod(
    'com.example.app.IRemoteService$Stub',
    'requestTicket',
    ['android.os.Bundle', 'com.example.app.IServiceCallback'],
);
```

Omitting `argTypes` on a multi-overload method throws
[`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror).

`allOverloads` is always populated — even for single-overload
methods (one-element array) — so callers can inspect the full set.

#### Falling through to plain `Java.use`

The classic tier-3 pattern: resolve, then call into Frida directly
without going through the proxy layer.

```typescript
const m = rosetta.map.resolveMethod('com.example.app.IRemoteService$Stub', 'requestTicket');
Java.use(m.className)[m.obfName]
    .overload('android.os.Bundle', 'bbbb')
    .implementation = function (b, cb) {
        send({ stage: 'raw-hook' });
        return this[m.obfName].apply(this, arguments);
    };
```

This is exactly what `rosetta.hook(...)` does under the hood. Drop
to it when you need control the wrapper takes away (e.g. wrapping
Frida's own overload-selection logic).

### `rosetta.map.resolveField`

```typescript
const f = rosetta.map.resolveField('com.example.app.Config', 'MAX_RETRIES');
// → { realName: 'MAX_RETRIES',
//     obfName: 'b',
//     className: 'nnnn',
//     type: 'I',
//     static: true }
```

The `type` field is the JVM descriptor (`I` for `int`, `J` for
`long`, `Ljava/lang/String;` for `String`, etc.).

### `rosetta.map.override`

Install a runtime override for a class entry. Future lookups see the
override instead of the map's value. Caches are invalidated
automatically for the overridden name.

```typescript
rosetta.map.override('com.example.app.IRemoteService$Stub', {
    obfuscated: 'xyz',
    kind: 'aidl_stub',
    methods: {
        requestTicket: { obfuscated: 'a', signature: '(Landroid/os/Bundle;Lbbbb;)V' },
    },
});
```

Use cases:

- **Hot-patching** a map gap mid-session without rebuilding the
  bundle.
- **Test fixtures** — feeding a session a synthetic class entry to
  exercise the rest of the pipeline.
- **V2+ runtime discovery** will populate overrides automatically;
  in V1 you do this by hand.

The override replaces the entire `ClassEntry`. If you only want to
amend one method, read the existing entry first, mutate, write back:

```typescript
const cls = rosetta.map.resolveClass('com.example.app.Foo');
const entry = { ...cls.entry, methods: { ...cls.entry.methods, newMethod: { obfuscated: 'd', signature: '()V' } } };
rosetta.map.override('com.example.app.Foo', entry);
```

### `rosetta.map.extract`

Returns the bound `RosettaMap` (after registry resolution if
applicable). The returned object is the same one the session loaded
— don't mutate it; use `override` instead.

```typescript
const map = rosetta.map.extract();
send({
    stage: 'session-info',
    app: map.app,
    version: map.version,
    classes: Object.keys(map.classes).length,
});
```

Useful for diagnostic reporting and integrating with host-side
tooling that wants to know what map is active.

### Errors

The four resolve methods raise the standard resolver errors:

| Error | When |
|---|---|
| [`ResolveError`](../reference/errors.md#resolveerror) | The real name isn't in the map. |
| [`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror) | `resolveMethod` called on a multi-overload method without `argTypes`. |

`override` and `extract` don't throw — they're pure reads/writes on
the resolver state.

## `rosetta.events`

The diagnostic event surface. Subscribe to every resolve, every
health-check, every detect, every map-load.

```typescript
interface EventsApi {
    on(listener: EventListener): () => void;
    onType<T extends DiagnosticEvent['type']>(
        type: T,
        listener: EventListener<Extract<DiagnosticEvent, { type: T }>>,
    ): () => void;
}
```

Like `rosetta.map`, `rosetta.events` is property-getter-shaped — it
rebuilds the API against the current ambient session on each access.

### `rosetta.events.on`

Subscribe to all events:

```typescript
const off = rosetta.events.on((event) => {
    send({ rosettaEvent: event });
});

// ... later ...
off();   // unsubscribe
```

The returned function unsubscribes the listener. Idempotent —
calling it twice is a no-op.

### `rosetta.events.onType`

Subscribe to events of one type, with full TypeScript narrowing on
the listener's argument:

```typescript
rosetta.events.onType('resolve', (e) => {
    if (e.miss) {
        send({ stage: 'unresolved', name: e.name, scope: e.classScope });
    }
});

rosetta.events.onType('health-check', (e) => {
    send({ stage: 'health', passed: e.passed, rate: e.rate });
});

rosetta.events.onType('detect', (e) => {
    send({ stage: 'detect', app: e.app, version: e.version, source: e.source });
});

rosetta.events.onType('map-load', (e) => {
    send({ stage: 'map-load', classes: e.classCount });
});
```

### Event types

Four event kinds; see [Events reference](../reference/events.md) for
field-by-field documentation.

| `type` | Emitted when |
|---|---|
| `'resolve'` | A real name is translated to obfuscated (or misses). Fires inside every tier-1, tier-2, tier-3 resolver call. |
| `'health-check'` | Attach-time health check completed. Carries `passed`, `rate`, `failedEntries`, `threshold`. |
| `'detect'` | App / version was determined at session start. `source: 'auto'` or `'override'`. |
| `'map-load'` | Map was selected (post-registry-pick if applicable). Carries `app`, `version`, `classCount`, `schemaVersion`. |

### Trace mode and `rosetta.events` coexist

Setting `trace: true` on the session emits the same events to
`console.error` as readable single-line strings *in addition to*
delivering them to programmatic subscribers. Use both:

```typescript
rosetta.session({ map, trace: true });

rosetta.events.onType('resolve', (e) => {
    if (e.miss) {
        send({ alert: 'unresolved', name: e.name });
    }
});
```

Stderr trace is for development; `send()`-channel subscription is for
the host controller to aggregate or fail CI on misses.

## Tier-3 lower-level handles

If you need to compose your own session wiring — typically for
multi-session scripts or for tests — the package re-exports the
underlying primitives:

| Symbol | Purpose |
|---|---|
| `createResolver(map, options)` | Build a Resolver bound to a map + EventBus. |
| `ResolverImpl` | Concrete class behind `createResolver`. |
| `makeClassProxy`, `makeMethodHandle`, `makeFieldAccessor`, `makeInstanceProxy` | Build proxy objects directly without going through `rosetta.use`. |
| `EventBus`, `createSilentBus` | Build an event bus directly. |
| `makeSentinel`, `isSentinel` | Sentinels for the `warn` failure policy — see [Design — sentinels](../reference/design.md#sentinels-the-warn-failure-policy). |

```typescript
import { createResolver, EventBus } from 'rosetta-frida';

const events = new EventBus();
const resolver = createResolver(map, { events, failurePolicy: 'strict' });

const cls = resolver.resolveClass('com.example.app.Foo');
```

For two simultaneous sessions in one script, build them explicitly
via [`createSession`](../api/session.md) — see [Advanced
composition](overview.md#advanced-composition).
