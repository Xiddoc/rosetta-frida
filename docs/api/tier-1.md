# Tier 1 — declarative hooks

The default. One-line declarative installation, plus three helpers
that round out the common cases.

| Function | Purpose |
|---|---|
| [`rosetta.hook`](#rosettahook) | Install a method hook by real name. |
| [`rosetta.proceed`](#rosettaproceed) | From inside a hook impl, call the next-in-chain implementation. |
| [`rosetta.field`](#rosettafield) | Read a field value off an instance by real name. |
| [`rosetta.setField`](#rosettasetfield) | Write a field value on an instance by real name. |

## `rosetta.hook`

### Signature

```typescript
rosetta.hook(
    target: string | HookTarget,
    impl: HookImpl,
): HookHandle;

type HookImpl = (this: unknown, ...args: unknown[]) => unknown;

interface HookTarget {
    readonly class: string;
    readonly method: string;
    readonly args: readonly string[];   // real-name arg types
}

interface HookHandle {
    detach(): void;
    readonly detached: boolean;
}
```

### Two call shapes

```typescript
// String form — class and method on the dot.
rosetta.hook(
    'com.example.app.IRemoteService$Stub.requestTicket',
    function (bundle, callback) { return rosetta.proceed(bundle, callback); },
);

// Object form — explicit overload disambiguation.
rosetta.hook(
    {
        class: 'com.example.app.IRemoteService$Stub',
        method: 'requestTicket',
        args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
    },
    function (bundle, callback) { return rosetta.proceed(bundle, callback); },
);
```

The string form works when the method has exactly one overload in
the map. If there are multiple overloads, the library throws
[`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror)
and the error message tells you to use the object form.

### Arg-type translation

In the object form, `args` is a list of **real names**. The resolver
translates entries that match a class in the loaded map; primitives
(`int`, `boolean`) and framework types (`android.os.Bundle`) pass
through verbatim.

```typescript
rosetta.hook({
    class: 'com.example.app.BlobCache',
    method: 'put',
    args: ['java.lang.String', 'java.lang.Object', 'long'],  // all framework / primitive
}, function (key, val, ttl) {
    return rosetta.proceed(key, val, ttl);
});
```

If two overloads of the same method differ only in arg count (no
type overlap), passing the shorter `args` array selects that
overload. If they share an arg count but differ in types, supply the
specific types.

### `HookHandle.detach()`

`hook(...)` returns a handle. Call `.detach()` to restore the
overload's previous implementation. This is reentrant and safe to
call multiple times.

```typescript
const handle = rosetta.hook('Foo.bar', function () { /* ... */ });

// ... later, conditionally tear down ...
if (someCondition) handle.detach();
```

`handle.detached` becomes `true` after the first successful call.

### What this is doing under the hood

1. The session's Resolver translates `class` and `method` to obf
   names — and selects the matching overload if you passed `args`.
2. `Java.use(obfClass)` produces the native class wrapper.
3. The library parses the resolved method's JVM signature
   (`(Landroid/os/Bundle;Lbbbb;)V`) into Frida-shaped overload type
   args (`['android.os.Bundle', 'bbbb']`) and calls
   `methodBundle.overload(...)`.
4. Your `impl` is wrapped in a frame that pushes onto the
   [`proceed`](#rosettaproceed) stack on entry and pops on exit.
5. `.implementation = wrappedImpl` installs the hook.

When `.detach()` runs, step 5 is reversed —
`.implementation = previous`, where `previous` was captured at
install time.

### Errors

| Error | When |
|---|---|
| [`ResolveError`](../reference/errors.md#resolveerror) | The class or method isn't in the map. |
| [`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror) | String form used on a multi-overload method. |
| [`RosettaError`](../reference/errors.md#rosettaerror) | Target string isn't `Class.method` shaped; `globalThis.Java` is missing; the method bundle lacks `.overload()`. |

## `rosetta.proceed`

### Signature

```typescript
rosetta.proceed(...args: unknown[]): unknown;
```

### Semantics

From inside a hook implementation, `rosetta.proceed(a, b, c)` calls
**the next-in-chain** implementation — that is, whatever was on the
overload before your hook layered on top. When yours is the first
hook installed on a method, the next-in-chain is the original method
body.

This matches Frida's normal `this.foo.apply(this, arguments)`
semantics. Users coming from Frida will intuit it.

```typescript
rosetta.hook('Foo.bar', function (x, y) {
    send({ stage: 'before-bar', x, y });
    const result = rosetta.proceed(x, y);   // original Foo.bar(x, y)
    send({ stage: 'after-bar', result });
    return result;
});
```

You can also transform args before forwarding:

```typescript
rosetta.hook('Foo.bar', function (x, y) {
    return rosetta.proceed(x * 2, y);   // double x before passing on
});
```

Or short-circuit by returning a value of your own without proceeding:

```typescript
rosetta.hook('Foo.isFeatureEnabled', function () {
    return true;   // force-enable
});
```

### Errors

Calling `rosetta.proceed(...)` outside any active hook implementation
throws `RosettaError`:

```text
rosetta.proceed called outside a hook implementation. Only call proceed(...) from inside a function passed to rosetta.hook(...).
```

### Nested hooks

When hook A calls `rosetta.proceed(...)` and that lands in hook B
(installed on the same overload at a different time), B's call to
`rosetta.proceed(...)` reaches into the implementation that existed
before B was installed. The proceed-context stack is LIFO and tracks
nested calls naturally.

## `rosetta.field`

### Signature

```typescript
rosetta.field(instance: unknown, realFieldName: string): unknown;
```

### Behavior

Reads the named field off the instance and returns its value (Frida
unwraps `.value` automatically; the helper does the same).

```typescript
rosetta.hook('com.example.app.RemoteServiceClient.requestTicket',
    function (this: unknown, bundle: unknown) {
        const sid = rosetta.field(this, 'sessionId') as string | null;
        send({ stage: 'client-call', sessionId: sid });
        return rosetta.proceed(bundle);
    },
);
```

### Static fields

For static fields, you have two equivalent options:

```typescript
// Tier 1 — static field via a Class instance (rarely useful):
rosetta.field(SomeClass, 'CONSTANT');

// Tier 2 — static field via the class proxy:
const Config = rosetta.use('com.example.app.Config');
const max = Config.MAX_RETRIES.value as number;
```

The tier-2 form is the idiomatic one for static fields. Tier 1 is
shaped around instances.

### Class detection

The helper determines an instance's class by:

1. Reading `instance.$className` (Frida sets this to the obfuscated
   short name on every wrapper).
2. Falling back to `instance.class.getName()`.
3. Throwing `RosettaError` if neither yields a name, or
   `ResolveError` if the obfuscated class name isn't in the loaded
   map.

### Errors

| Error | When |
|---|---|
| `RosettaError` | `instance` is not an object; class cannot be determined; field is not present on the instance; the instance does not expose a `.value` accessor. |
| `ResolveError` | The field is not mapped on the instance's class, or the instance's class is not in the loaded map. |

## `rosetta.setField`

### Signature

```typescript
rosetta.setField(instance: unknown, realFieldName: string, value: unknown): void;
```

### Behavior

Mirror of `rosetta.field` for writes:

```typescript
rosetta.hook('com.example.app.RemoteServiceClient.requestTicket',
    function (this: unknown, bundle: unknown) {
        rosetta.setField(this, 'flags', 0);   // clear flags before calling
        return rosetta.proceed(bundle);
    },
);
```

Same class-detection chain, same errors.

## Putting it together

The canonical sample hook combines all four tier-1 calls:

```typescript
import sampleMap from './maps/com.example.app/30405.json' with { type: 'json' };
import { rosetta, type RosettaMap } from 'rosetta-frida';

const map = sampleMap as unknown as RosettaMap;

Java.perform(() => {
    rosetta.session({ map, failurePolicy: 'warn' });

    // String-form hook, single overload.
    rosetta.hook(
        'com.example.app.RemoteServiceClient.requestTicket',
        function (this: unknown, ...args: unknown[]) {
            const sid = rosetta.field(this, 'sessionId') as string | null;
            send({ stage: 'client-call', sessionId: sid });
            return rosetta.proceed(...args);
        },
    );

    // Object-form hook, overload-disambiguated.
    rosetta.hook(
        {
            class: 'com.example.app.IRemoteService$Stub',
            method: 'requestTicket',
            args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
        },
        function (bundle: unknown, callback: unknown) {
            send({ stage: 'requestTicket' });
            return rosetta.proceed(bundle, callback);
        },
    );
});
```

See [the sample hook walkthrough](../recipes/aidl-stub-hook.md) for
the annotated tour.
