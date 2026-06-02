# Recipe — field access

How to read and write Java fields by real name. Two patterns —
instance fields on a `this`/arg inside a hook body, and static fields
on a class wrapper.

## Instance fields

The canonical pattern: hook a method, read `this.<realFieldName>`
from inside the hook body.

```typescript
rosetta.hook(
    'com.example.app.RemoteServiceClient.requestTicket',
    function (this: unknown, ...args: unknown[]) {
        const sid = rosetta.field(this, 'sessionId') as string | null;
        send({ stage: 'client-call', sessionId: sid });
        return rosetta.proceed(...args);
    },
);
```

In the sample map, `RemoteServiceClient` has:

```json
"com.example.app.RemoteServiceClient": {
    "obfuscated": "dddd",
    "fields": {
        "sessionId": {
            "obfuscated": "a",
            "type": "Ljava/lang/String;"
        },
        "flags": {
            "obfuscated": "b",
            "type": "I"
        }
    }
}
```

`rosetta.field(this, 'sessionId')` finds the instance's class (via
`this.$className`), reverse-looks it up to `RemoteServiceClient`,
resolves the field `sessionId` to obfuscated name `a`, then returns
`this.a.value`.

The return type is `unknown` — cast to your expected runtime type.

## Writing instance fields

```typescript
rosetta.hook(
    'com.example.app.RemoteServiceClient.requestTicket',
    function (this: unknown, ...args: unknown[]) {
        rosetta.setField(this, 'flags', 0);   // clear flags before calling
        return rosetta.proceed(...args);
    },
);
```

Symmetric with `rosetta.field` — same class detection, same
resolution chain.

## Static fields

For static fields, use the tier-2 `rosetta.use(...)` proxy. The
field accessor on the class wrapper is symmetrical to Frida's normal
`Klass.field.value` shape:

```typescript
const Config = rosetta.use('com.example.app.Config');
const max = Config.MAX_RETRIES.value as number;
send({ stage: 'config-snapshot', maxRetries: max });

Config.MAX_RETRIES.value = 999;
```

In the sample map:

```json
"com.example.app.Config": {
    "obfuscated": "nnnn",
    "fields": {
        "MAX_RETRIES": {
            "obfuscated": "b",
            "type": "I",
            "static": true
        },
        "ENABLE_TRACING": {
            "obfuscated": "a",
            "type": "Z",
            "static": true
        },
        "ENDPOINT_URL": {
            "obfuscated": "d",
            "type": "Ljava/lang/String;",
            "static": true
        }
    }
}
```

Each field is `static: true`. The class is fields-only — there are no
methods on the user-facing surface — which is normal for
configuration holders.

### Reading static fields via tier 1

Tier 1's `rosetta.field` is shaped around instances. For static
fields, the canonical path is tier 2:

```typescript
// Tier 2 — recommended for static fields.
const Config = rosetta.use('com.example.app.Config');
const max = Config.MAX_RETRIES.value as number;

// Tier 1 — works with the Class instance, less idiomatic.
const ConfigClass = rosetta.use('com.example.app.Config');
const max2 = rosetta.field(ConfigClass.$native, 'MAX_RETRIES') as number;
```

The tier-1 form requires the `Class<?>` object as the receiver,
which is what `$native` is. It works, but tier 2 is shorter and more
readable.

## Field types

Field `type` in the map is a JVM descriptor:

| Descriptor | Java type |
|---|---|
| `Z` | `boolean` |
| `B` | `byte` |
| `C` | `char` |
| `S` | `short` |
| `I` | `int` |
| `J` | `long` |
| `F` | `float` |
| `D` | `double` |
| `Ljava/lang/String;` | `String` |
| `Lcom/example/app/Foo;` | reference (obfuscated form on disk) |
| `[I` | `int[]` |
| `[Lcom/example/app/Foo;` | `Foo[]` |

For object-typed fields whose target is a mapped class, the on-disk
descriptor uses the obfuscated short name (`Lbbbb;`). The resolver's
reverse index gives you `IServiceCallback`'s real name back at
runtime.

## Reading complex field types

For `String` fields, the `.value` accessor returns a JS string
directly:

```typescript
const url = Config.ENDPOINT_URL.value as string;
```

For object references (`Lbbbb;`), `.value` returns the Frida wrapper
for the underlying instance — i.e., you can call methods on it
directly:

```typescript
const SessionManager = rosetta.use('com.example.app.SessionManager');
const client = SessionManager.INSTANCE.value as { /* RemoteServiceClient wrapper */ };
// `client` is a Frida instance wrapper — methods on it dispatch correctly.
```

For arrays (`[I`, `[Ljava.lang.Object;`), `.value` gives you a
JavaScript-array-shaped Frida proxy:

```typescript
const arr = Config.SOME_INT_ARRAY.value as number[];
for (let i = 0; i < arr.length; i++) {
    send({ idx: i, val: arr[i] });
}
```

## Writing complex field types

For primitive writes — `int`, `long`, `boolean`, etc. — pass a JS
number / boolean:

```typescript
Config.MAX_RETRIES.value = 10;
Config.ENABLE_TRACING.value = true;
```

For `String` writes, pass a JS string:

```typescript
Config.ENDPOINT_URL.value = 'https://localhost:8080';
```

For object writes, pass a Frida instance wrapper. The usual
constructions:

- A wrapper you just constructed: `Ticket.$new('seed').` then
  `assign that into the field`.
- A wrapper you pulled out of `this.someOtherField.value`.
- A wrapper passed into your hook as an argument.

Don't pass raw JS objects — Frida won't auto-convert them, and the
write will fail.

## Errors

| Error | When |
|---|---|
| `RosettaError` | The instance is not an object; `$className` and `class.getName()` are both unavailable; the field is not present on the underlying instance. |
| [`ResolveError`](../reference/errors.md#resolveerror) | The instance's class is not in the map; or the field is not mapped on the class. |

## Edge case — instance class not in the map

The class-detection chain (`$className` → `class.getName()`) reads
the *obfuscated* short name off the instance and reverse-looks it up
to a real name. If that obfuscated name has no entry in the loaded
map, you get:

```text
ResolveError: rosetta-frida: cannot reverse-lookup class 'xyz' — the running instance's class is not in the loaded map.
```

This usually means the map is incomplete — add an entry for the
class and retry. Or: the instance is of an unmapped subclass, in
which case you can map the *superclass* (with `extends`) and read
fields from the parent.
