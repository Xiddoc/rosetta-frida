# Recipe — overloaded methods

When one real method name has multiple overloads in the map, the
string form of `rosetta.hook(...)` is ambiguous and throws
[`AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror).
Disambiguate with the object form by specifying the real-name arg
types.

## Two overloads of the same name

From the sample map:

```json
"com.example.app.BlobCache": {
    "obfuscated": "hhhh",
    "methods": {
        "put": [
            {
                "obfuscated": "d",
                "signature": "(Ljava/lang/String;Ljava/lang/Object;)V"
            },
            {
                "obfuscated": "e",
                "signature": "(Ljava/lang/String;Ljava/lang/Object;J)V"
            }
        ]
    }
}
```

Two `put` overloads: a 2-arg `(String, Object) → void` and a 3-arg
`(String, Object, long) → void` (the second includes a TTL).

## The string form throws

```typescript
rosetta.hook('com.example.app.BlobCache.put', function (...args) {
    return rosetta.proceed(...args);
});
```

```text
AmbiguousOverloadError: rosetta-frida: 2 overloads exist for BlobCache.put; pass `args` to disambiguate.
```

## Disambiguate with `args`

The object form names the args by real name (or framework type, or
primitive). The resolver translates each entry that matches a real
name in the map; primitives and framework types pass through.

```typescript
// Hook the 2-arg overload (no TTL).
rosetta.hook(
    {
        class: 'com.example.app.BlobCache',
        method: 'put',
        args: ['java.lang.String', 'java.lang.Object'],
    },
    function (key, value) {
        send({ stage: 'put-2arg', key });
        return rosetta.proceed(key, value);
    },
);

// Hook the 3-arg overload (with TTL).
rosetta.hook(
    {
        class: 'com.example.app.BlobCache',
        method: 'put',
        args: ['java.lang.String', 'java.lang.Object', 'long'],
    },
    function (key, value, ttl) {
        send({ stage: 'put-3arg', key, ttl });
        return rosetta.proceed(key, value, ttl);
    },
);
```

`'java.lang.String'`, `'java.lang.Object'`, `'long'` are all
framework / primitive types — pass-through. If the map's signatures
included refs to other mapped classes (`Lbbbb;`), you'd write the
**real name** of those classes in `args` — the resolver translates
under the hood.

## Three real-name types in one call

Mix freely:

```typescript
rosetta.hook(
    {
        class: 'com.example.app.IRemoteService$Stub',
        method: 'requestTicket',
        args: [
            'android.os.Bundle',                     // framework — passthrough
            'java.lang.String',                       // framework — passthrough
            'com.example.app.IServiceCallback',      // real-name — translated to 'bbbb'
        ],
    },
    function (bundle, tag, callback) {
        return rosetta.proceed(bundle, tag, callback);
    },
);
```

## Discovering overloads programmatically

When you don't know the overloads ahead of time, use tier 3 to
inspect the map:

```typescript
const cls = rosetta.map.resolveClass('com.example.app.BlobCache');
const put = cls.entry.methods?.put;
const overloads = Array.isArray(put) ? put : put ? [put] : [];

for (const overload of overloads) {
    send({
        stage: 'overload',
        obf: overload.obfuscated,
        signature: overload.signature,
    });
}
```

Then iterate through `overloads` and install one hook per signature.

## Static overloaded methods

Same disambiguation. Add `static: true` to the map entry so the
resolver knows the receiver shape; the hook surface itself is
unchanged:

```json
"valueOf": {
    "obfuscated": "valueOf",
    "signature": "(Ljava/lang/String;)Ljjjj;",
    "static": true
}
```

```typescript
rosetta.hook(
    {
        class: 'com.example.app.ErrorCode',
        method: 'valueOf',
        args: ['java.lang.String'],
    },
    function (name) {
        send({ stage: 'enum-valueOf', name });
        return rosetta.proceed(name);
    },
);
```

## Constructor overloads

Constructors are written `<init>` and almost always overload-array
form:

```json
"<init>": [
    {
        "obfuscated": "<init>",
        "signature": "(Ljava/lang/String;)V",
        "is_constructor": true
    },
    {
        "obfuscated": "<init>",
        "signature": "(Ljava/lang/String;J)V",
        "is_constructor": true
    }
]
```

```typescript
rosetta.hook(
    {
        class: 'com.example.app.Ticket',
        method: '<init>',
        args: ['java.lang.String'],
    },
    function (this: unknown, seed: unknown) {
        send({ stage: 'Ticket-ctor-1arg', seed });
        return rosetta.proceed(seed);
    },
);
```

## Tier-2 disambiguation

If you prefer the `Java.use`-shape, tier 2's `.overload(...)`
disambiguates the same way (the arg-translation rule is identical):

```typescript
const BlobCache = rosetta.use('com.example.app.BlobCache');

BlobCache.put
    .overload('java.lang.String', 'java.lang.Object')
    .implementation = function (key, value) {
        send({ stage: 'put-2arg-tier2', key });
        return this.put(key, value);
    };
```

`BlobCache.put.overloads` exposes the underlying overload-handle array
for tier-3 inspection.

## Tier-3 deepest form

When you need control the tier-1 wrapper doesn't give:

```typescript
const m = rosetta.map.resolveMethod(
    'com.example.app.BlobCache',
    'put',
    ['java.lang.String', 'java.lang.Object'],
);

Java.use(m.className)[m.obfName]
    .overload('java.lang.String', 'java.lang.Object')
    .implementation = function (k: unknown, v: unknown) {
        send({ stage: 'put-raw', method: m.obfName });
        return (this[m.obfName] as (...a: unknown[]) => unknown).apply(this, arguments);
    };
```

This is what tier 1 expands to internally; reach for it when you
want to wrap the wrapper.

## When you can't tell which overload fired

In Frida, two same-named overloads with the same arity but different
arg *types* (a common pattern with generics erasure) can be hard to
distinguish. The hook handler receives the arg list either way.
Inspect `this.$className` and the args' actual types at runtime:

```typescript
rosetta.hook(
    {
        class: 'com.example.app.Foo',
        method: 'bar',
        args: ['java.lang.Object'],
    },
    function (this: unknown, arg: unknown) {
        const cls = (arg as { $className?: string })?.$className;
        send({ stage: 'foo-bar', argClass: cls });
        return rosetta.proceed(arg);
    },
);
```

Or use tier 3 to register one hook per concrete arg-type combination
the map describes.

## Related

- [Tier 1 — `rosetta.hook` object form](../api/tier-1.md#two-call-shapes)
- [Tier 2 — `.overload(...)` argument translation](../api/tier-2.md#overload-argument-translation)
- [Errors — `AmbiguousOverloadError`](../reference/errors.md#ambiguousoverloaderror)
