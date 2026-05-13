# Tier 2 — `Java.use`-shaped

The intermediate tier. Mirrors Frida's `Java.use(obfName)` shape, but
takes a real name and translates everything through the loaded
Resolver. Reach for it when:

- You want the familiar
  `Klass.method.overload(...).implementation = fn` shape.
- You need to read a static field off a class wrapper.
- You want to capture a class proxy and re-use it across multiple
  methods.

| Function | Purpose |
|---|---|
| [`rosetta.use`](#rosettause) | Resolve a real class name → `ClassProxy`. |
| [`rosetta.type`](#rosettatype) | Translate a single real type name → its obfuscated form (or pass through). |

## `rosetta.use`

### Signature

```typescript
rosetta.use(realName: string): ClassProxy;
```

### What you get back

A `ClassProxy` — a wrapper around `Java.use(obfName)` that translates
property accesses through the Resolver:

```typescript
interface ClassProxy {
    readonly $realName: string;
    readonly $obfName: string;
    readonly $native: unknown;
    readonly $resolver: Resolver;
    $new(...args: unknown[]): unknown;
    [member: string]: unknown;   // dynamic real-name access
}
```

### Method access

```typescript
const Stub = rosetta.use('com.example.app.IRemoteService$Stub');

// Real method name → MethodHandle (memoized per access).
Stub.requestTicket
    .overload('android.os.Bundle', 'com.example.app.IServiceCallback')
    .implementation = function (bundle, callback) {
        send({ stage: 'requestTicket' });
        return this.requestTicket(bundle, callback);
    };
```

`Stub.requestTicket` returns a `MethodHandle`:

```typescript
interface MethodHandle {
    overload(...argTypes: readonly string[]): OverloadHandle;
    readonly overloads: readonly OverloadHandle[];
    implementation: ((...args: unknown[]) => unknown) | null;
    readonly $native: unknown;
}
```

`Stub.requestTicket.implementation = fn` is shorthand for "set on the
auto-picked overload" — it works only when exactly one overload
exists in the map. With multiple overloads, you must call
`.overload(...)` first.

### Overload argument translation

Arguments to `.overload(...)` can mix real names, primitives, and
framework types freely:

```typescript
Stub.requestTicket.overload(
    'android.os.Bundle',                         // framework — pass-through
    'com.example.app.IServiceCallback',          // real name — translated to 'bbbb'
)
```

The translation rule: if the arg matches a class real-name in the
loaded map → translate to obfuscated. Otherwise — Java primitives
(`int`, `boolean`), framework types (`android.os.Bundle`), unmapped
types — pass through verbatim.

This is the same translation `rosetta.type(...)` does. The two forms
are equivalent:

```typescript
// Implicit translation:
Stub.requestTicket.overload('android.os.Bundle', 'com.example.app.IServiceCallback')

// Explicit translation:
Stub.requestTicket.overload('android.os.Bundle', rosetta.type('com.example.app.IServiceCallback'))
```

Use the explicit form when you want to log or inspect the translated
name first.

### Constructors

`$new(...args)` constructs an instance, delegating to Frida's
`wrapper.$new(...)`:

```typescript
const Ticket = rosetta.use('com.example.app.Ticket');
const instance = Ticket.$new('seed-value');
```

The returned value is wrapped in an `InstanceProxy` so instance-field
access (via `rosetta.field(...)`) translates correctly.

### Static field access

```typescript
const Config = rosetta.use('com.example.app.Config');
const max = Config.MAX_RETRIES.value as number;
Config.MAX_RETRIES.value = 10;
```

Real field name → `FieldAccessor` (memoized):

```typescript
interface FieldAccessor<T = unknown> {
    value: T;
}
```

The `.value` accessor mirrors Frida's standard field-access shape.

### Tier-3 introspection properties

`$`-prefixed properties expose the internals for debugging / tier-3
fall-through:

| Property | Value |
|---|---|
| `$realName` | The real fully-qualified name you passed to `rosetta.use(...)`. |
| `$obfName` | The obfuscated short name the resolver picked. |
| `$native` | The underlying `Java.use(obfName)` wrapper. |
| `$resolver` | The Resolver instance this proxy was built against. |

Use `$native` to fall through to raw Frida when the proxy gets in
your way:

```typescript
const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
const native = Stub.$native as { /* Frida class wrapper */ };
// ... talk to `native` directly when needed ...
```

### Errors

| Error | When |
|---|---|
| [`ResolveError`](../reference/errors.md#resolveerror) | The class isn't in the map (strict) — or the sentinel proxy throws [`UnresolvedAccessError`](../reference/errors.md#unresolvedaccesserror) when used (warn). |
| `Error` | `globalThis.Java` isn't available (non-Frida context). |

## `rosetta.type`

### Signature

```typescript
rosetta.type(realName: string): string;
```

### Behavior

Single-name translation. Real-name match in map → obfuscated name.
Anything else — primitives, framework types, unmapped types — pass
through verbatim.

```typescript
rosetta.type('com.example.app.IServiceCallback');  // → 'bbbb'
rosetta.type('android.os.Bundle');                 // → 'android.os.Bundle' (passthrough)
rosetta.type('int');                                // → 'int' (passthrough)
rosetta.type('java.lang.String');                  // → 'java.lang.String' (passthrough)
```

The translation rule is exactly the same one `.overload(...)` uses
implicitly on its string args. `rosetta.type(...)` exists so you can
do the translation explicitly when:

- You want to log or inspect the translated name before passing it on.
- You need to compose translated names by hand (e.g. building a JVM
  signature string).
- You want to fail loudly if a name *should* have translated and
  didn't (you can compare the input and output).

### Errors

`rosetta.type(...)` never throws on an unmapped name — it
passes-through. To fail on unmapped:

```typescript
const obf = rosetta.type('com.example.app.IFoo');
if (obf === 'com.example.app.IFoo') {
    throw new Error('expected com.example.app.IFoo to be in the map');
}
```

For the strict version that throws on miss, use the tier-3
`rosetta.map.resolveClass(...)` instead.

## Idioms

### Capture a class proxy, hook many methods

```typescript
const Stub = rosetta.use('com.example.app.IRemoteService$Stub');

Stub.requestTicket
    .overload('android.os.Bundle', 'com.example.app.IServiceCallback')
    .implementation = function (b, cb) {
        send({ method: 'requestTicket' });
        return this.requestTicket(b, cb);
    };

Stub.requestPrompt
    .overload('android.os.Bundle', 'com.example.app.IDialogCallback')
    .implementation = function (b, cb) {
        send({ method: 'requestPrompt' });
        return this.requestPrompt(b, cb);
    };
```

### Read a static field, override it

```typescript
const Config = rosetta.use('com.example.app.Config');
const original = Config.MAX_RETRIES.value as number;
send({ stage: 'config-snapshot', maxRetries: original });
Config.MAX_RETRIES.value = 999;
```

### Instance access inside a tier-1 hook

The most common pattern — tier-1 hook for the method, tier-1 helper
for field access on `this`:

```typescript
rosetta.hook('com.example.app.RemoteServiceClient.requestTicket',
    function (this: unknown, ...args: unknown[]) {
        const sid = rosetta.field(this, 'sessionId') as string | null;
        send({ stage: 'client-call', sessionId: sid });
        return rosetta.proceed(...args);
    },
);
```

### Tier-3 fall-through via `$native`

When the proxy interferes (e.g. you want to call into a method that
isn't in the map at all):

```typescript
const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
const native = Stub.$native as Record<string, unknown>;
// ... call `native.somethingUnmapped` directly ...
```

This is rare and intentionally awkward — if you reach for it often,
your map is incomplete and you should fix that instead.
