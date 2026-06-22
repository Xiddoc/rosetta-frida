# Recipe — hooking an AIDL stub

A lucky special case. Most classes you map are anchored generically — by
a [stable string literal](string-anchored-class.md) or a
[stable framework parent](superclass-anchored-method.md) — because that
is all the obfuscator leaves you. AIDL stubs are the exception: they hand
you an unusually strong anchor for free (a stable `DESCRIPTOR` string and
transaction codes), so when a class *is* a stub, lean into it *while
authoring the signatures*. Just don't assume a class is AIDL — most are not.

> **The AIDL evidence lives in the signatures source, not the map.** As of
> `schema_version: 5` the published map is a pure real→obfuscated mapping:
> a stub is just `kind: class` and a callback `kind: interface`, with no
> `aidl_descriptor` / `aidl_txn` / `anchors` fields. You still *hook the
> stub by its real name* exactly as below — the descriptor and transaction
> codes simply guided sigmatcher to the class; they are no longer carried
> in the emitted artifact.

AIDL stubs are the binder dispatch surface between processes — when one
Android process wants to call into a service running in another, that
call lands on a `Foo$Stub` descendant in the service process. Hooking the
stub captures every IPC into the service.

This recipe walks through the canonical example from
`examples/sample-hook/hook.ts`, annotated.

## The target

In the sample map at `maps/com.example.app/30405.json`:

```json
"com.example.app.IRemoteService$Stub": {
    "obfuscated": "aaaa",
    "extends": "android.os.Binder",
    "kind": "class",
    "methods": {
        "requestTicket": [
            {
                "obfuscated": "c",
                "signature": "(Landroid/os/Bundle;Lbbbb;)V"
            },
            {
                "obfuscated": "d",
                "signature": "(Landroid/os/Bundle;Ljava/lang/String;Lbbbb;)V"
            }
        ]
    }
}
```

Two overloads of `requestTicket` — one with two args, one with three.
The two-arg overload is the common call path; the three-arg form takes an
opaque tag string. (The AIDL transaction codes that distinguish them are
authoring evidence in the signatures source, not map fields — at hook time
you disambiguate by argument types, below.)

## The hook

```typescript
import sampleMap from '../../maps/com.example.app/30405.json' with { type: 'json' };
import { rosetta, type RosettaMap } from 'rosetta-frida';

const map = sampleMap as unknown as RosettaMap;

Java.perform(() => {
    rosetta.session({
        map,
        trace: true,
        failurePolicy: 'warn',
    });

    rosetta.hook(
        {
            class: 'com.example.app.IRemoteService$Stub',
            method: 'requestTicket',
            args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
        },
        function (bundle: unknown, callback: unknown) {
            send({
                channel: 'sample',
                stage: 'requestTicket',
                bundleKeys: bundleKeys(bundle),
            });
            return rosetta.proceed(bundle, callback);
        },
    );
});

function bundleKeys(bundle: unknown): string[] {
    try {
        const b = bundle as { keySet?: () => { toArray?: () => string[] } | null } | null;
        const keySet = b?.keySet?.();
        const arr = keySet?.toArray?.();
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}
```

## Why the object form

`requestTicket` has two overloads in the map. If you wrote:

```typescript
rosetta.hook('com.example.app.IRemoteService$Stub.requestTicket', fn);
```

— the string form — rosetta would throw
[`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror)
because it doesn't know which overload you mean. The error message
tells you to use the object form and points at the
disambiguating-args trick.

The object form names the args by **real name**:

```typescript
args: ['android.os.Bundle', 'com.example.app.IServiceCallback']
```

The resolver translates each entry:

- `'android.os.Bundle'` → framework type, pass-through.
- `'com.example.app.IServiceCallback'` → resolves to the map's
  obfuscated name (`bbbb`).

Internally Frida ends up calling
`.overload('android.os.Bundle', 'bbbb')` and selects the 2-arg
overload. The 3-arg form (which takes
`'android.os.Bundle', 'java.lang.String', 'com.example.app.IServiceCallback'`)
is not selected.

## Why `rosetta.proceed`

Inside the hook body, we call `rosetta.proceed(bundle, callback)`.
This invokes whatever implementation was on the overload before this
hook layered on top — which, since this is the only hook, is the
original method body.

This is Frida's standard `this.foo.apply(this, arguments)` semantics
expressed as a function. See
[Tier 1 — `rosetta.proceed`](../api/tier-1.md#rosettaproceed) for the
full semantics.

We could mutate the args before forwarding:

```typescript
return rosetta.proceed(bundle, callback);
// versus
return rosetta.proceed(modifyBundle(bundle), callback);
```

Or short-circuit by returning a fabricated value:

```typescript
// Force the service to "accept" without making the real call.
return undefined;
```

For an AIDL stub, the return value is usually `void` (`)V` in the
signature) so short-circuiting just suppresses the call. For methods
returning data, return a fabricated `RosettaMap` instance or a Frida
wrapper.

## What you see at runtime

With `trace: true`, attaching prints:

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=4 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.IRemoteService$Stub ← aaaa (map)
[rosetta] com.example.app.IRemoteService$Stub.requestTicket ← c (map) (Landroid/os/Bundle;Lbbbb;)V
[rosetta] com.example.app.IServiceCallback ← bbbb (map)
```

The first three lines are the session setup. The next three are the
hook installation — class resolved, method overload picked, callback
type translated.

When the app makes its first call to `requestTicket`, the hook fires
and you receive a `send({ ... })` message on the host side:

```json
{
    "channel": "sample",
    "stage": "requestTicket",
    "bundleKeys": ["request_id", "client_version"]
}
```

## Variants

### Hook every overload

If you want both 2-arg and 3-arg `requestTicket`, install two hooks:

```typescript
rosetta.hook({
    class: 'com.example.app.IRemoteService$Stub',
    method: 'requestTicket',
    args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
}, function (b, cb) {
    send({ overload: 2, keys: bundleKeys(b) });
    return rosetta.proceed(b, cb);
});

rosetta.hook({
    class: 'com.example.app.IRemoteService$Stub',
    method: 'requestTicket',
    args: ['android.os.Bundle', 'java.lang.String', 'com.example.app.IServiceCallback'],
}, function (b, tag, cb) {
    send({ overload: 3, keys: bundleKeys(b), tag });
    return rosetta.proceed(b, tag, cb);
});
```

### Hook the callback too

To capture the *response* (what the service returns to the caller):

```typescript
rosetta.hook(
    'com.example.app.IServiceCallback.onResult',
    function (bundle: unknown) {
        send({ stage: 'onResult', keys: bundleKeys(bundle) });
        return rosetta.proceed(bundle);
    },
);
```

`onResult` has a single overload in the map (`a`, signature
`(Landroid/os/Bundle;)V`), so the string form works directly — no
disambiguation needed.

### Hook `onTransact` directly (tier 3)

For low-level inspection — hooking `onTransact` directly and logging
every transaction code the binder dispatches — drop to tier 3:

```typescript
const stub = rosetta.map.resolveClass('com.example.app.IRemoteService$Stub');
const stubWrapper = Java.use(stub.obfName) as { onTransact: unknown };

(stubWrapper as { onTransact: { overload: (...a: string[]) => { implementation: unknown } } })
    .onTransact
    .overload('int', 'android.os.Parcel', 'android.os.Parcel', 'int')
    .implementation = function (txn: number, data: unknown, reply: unknown, flags: number) {
        send({ stage: 'onTransact', class: 'com.example.app.IRemoteService$Stub', txn });
        return (this as { onTransact: (...a: unknown[]) => unknown }).onTransact(txn, data, reply, flags);
    };
```

The map no longer carries `aidl_txn` codes (they were authoring evidence,
not a resolver input), so map → transaction-code dispatch is no longer a
built-in. If you need it, keep a small txn→method table in your hook
script. This is rarely necessary — hooking the method directly by real
name is cleaner — but illustrates how tier 3 stays available for advanced
needs.

## Common gotchas

- **Forgetting `Java.perform`.** Frida requires Java APIs inside
  `Java.perform(...)`. rosetta's resolver doesn't call `Java.use`
  until you reach for a class, but you still need the wrapping for
  the call to succeed at runtime.
- **Hooking the wrong end.** The `$Stub` class runs inside the
  *service* process; the corresponding `$Stub$Proxy` runs in the
  *client* process. Hook the stub if you want to see incoming calls
  on the service side; hook the proxy if you want to see outgoing
  calls on the client side. They have different obfuscated names —
  both should be in your map.
- **Expecting AIDL metadata in the map.** As of `schema_version: 5` the
  map carries no `aidl_descriptor` / `aidl_txn` / `aidl_stub` fields — a
  stub is `kind: class`. Anchor on the descriptor while authoring the
  *signatures*; the map only records the resolved names.

## See also

- [Recipe — string-anchored class](string-anchored-class.md) — the
  default anchor when a class has no AIDL surface, just an embedded
  string literal.
- [Recipe — superclass-anchored method](superclass-anchored-method.md) —
  the default anchor when a class is pinned by a framework parent.
- [Concepts — anchoring](../getting-started/concepts.md#anchoring--how-a-map-entry-survives-rotation).
