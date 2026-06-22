# Recipe — hooking a string-anchored class

The default anchoring pattern. Most classes in a real app are **deep,
internal, and have no exposed API surface** — no AIDL descriptor, no
public interface, nothing the obfuscator is forced to leave readable.
They get the full rotation treatment: the class name becomes `aaaa` in
one release and something unrelated the next.

What the obfuscator *cannot* touch is the **data** a class embeds. A
string literal the developer wrote — an algorithm name, a log tag, a
JSON key, a URL path — is a constant in the constant pool, not a name in
the symbol table. It rides through every rotation untouched. That makes
a distinctive string the single most broadly applicable anchor, and the
one to reach for by default.

## The target

A crypto helper, buried somewhere internal, that calls
`Cipher.getInstance("AES/GCM/NoPadding")`. There is no public API on it
and the class name rotates every release — but the literal
`"AES/GCM/NoPadding"` is right there in the class, every version.

You pin the class on that literal **in the sigmatcher signatures source**
(a regex-over-smali match for `AES/GCM/NoPadding`). The signatures resolve
the class, and the emitted `schema_version: 5` map records only the
resolved real→obfuscated names — a pure mapping, no anchor field:

```json
"com.example.app.crypto.GcmCipherHelper": {
    "obfuscated": "f0a",
    "kind": "class",
    "methods": {
        "encrypt": {
            "obfuscated": "a",
            "signature": "([B[B)[B"
        }
    }
}
```

The real fully-qualified name (`com.example.app.crypto.GcmCipherHelper`)
is the name *you* type in hooks; `obfuscated: "f0a"` is what the class is
called in this version. The stable string `"AES/GCM/NoPadding"` is what
*located* `f0a` during signature authoring — it is finding evidence that
lives in the signatures YAML, not a field in the map. (Earlier schema
versions carried an `anchors` array on the entry; `schema_version: 5`
dropped it, because no resolver ever read it.)

## Finding the class

In jadx (or any dex grep), search the dex for the literal
`"AES/GCM/NoPadding"`. The hit lands you inside the obfuscated class
(`f0a` here); its method that calls `Cipher.getInstance(...)` is your
`encrypt`. Copy the obfuscated class and method names into the entry
above. When the app rotates, the class name changes but the string
search finds it again — the anchor is what makes the re-discovery
mechanical.

## The hook

You write against the **real** name; rosetta translates it through the
loaded map at runtime.

```typescript
import appMap from '../../maps/com.example.app/30405.json' with { type: 'json' };
import { rosetta, type RosettaMap } from 'rosetta-frida';

const map = appMap as unknown as RosettaMap;

Java.perform(() => {
    rosetta.session({
        map,
        trace: true,
        failurePolicy: 'warn',
    });

    // Real name in, obfuscated name resolved under the hood.
    rosetta.hook(
        'com.example.app.crypto.GcmCipherHelper.encrypt',
        function (plaintext: unknown, key: unknown) {
            send({ stage: 'encrypt', len: (plaintext as { length: number }).length });
            return rosetta.proceed(plaintext, key);
        },
    );
});
```

`encrypt` has a single overload in the map, so the string form
(`'Class.method'`) resolves without disambiguation. If the class had
several `encrypt` overloads you would switch to the object form and name
the arg types by real name — see
[Overloaded methods](overloaded-methods.md).

If you would rather hold the class and reach into it yourself, the tier-2
[`rosetta.use`](../api/tier-2.md) proxy works the same way:

```typescript
const Helper = rosetta.use('com.example.app.crypto.GcmCipherHelper');
Helper.encrypt.implementation = function (pt: unknown, key: unknown) {
    send({ stage: 'encrypt', len: (pt as { length: number }).length });
    return this.encrypt(pt, key);
};
```

## Why the literal survives obfuscation

Obfuscators (R8 / ProGuard / DexGuard) rename **symbols** — classes,
methods, fields — because those are identifiers the runtime resolves by
name, and shortening them shrinks the dex and frustrates a reader. A
string constant is **data**: it sits in the dex string pool and is loaded
by index, so renaming it would change program behavior. The obfuscator
therefore leaves `"AES/GCM/NoPadding"` exactly as written.

That is the whole trick: anchor on what the obfuscator is *structurally
unable* to rewrite. A name (the class's identity) is fragile; a literal
the class carries (its data) is durable.

A few practical notes:

- **Pick a distinctive string.** `""`, `"true"`, or `"0"` appear in
  thousands of classes and won't pin anything. Algorithm names, full URL
  paths, unusual error messages, and developer-written log tags are
  good — distinctive enough that the containing class is unambiguous.
- **Anchor on several strings in the signatures source.** A signature can
  require more than one stable literal for a tighter match and lower
  false-positive rate during re-discovery. That tightening happens in the
  sigmatcher YAML; the map itself stays a pure name mapping.
- **String encryption defeats this.** Some hardened apps encrypt their
  string constants and decrypt at runtime, so the literal isn't in the
  dex as plaintext. Then fall back to the
  [superclass anchor](superclass-anchored-method.md) or a runtime trace.

## What you see at runtime

With `trace: true`, attaching prints the session setup and the resolved
entry:

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=4 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.crypto.GcmCipherHelper ← f0a (map)
[rosetta] com.example.app.crypto.GcmCipherHelper.encrypt ← a (map) ([B[B)[B
```

The health check confirmed `f0a` carries the `"AES/GCM/NoPadding"`
anchor, so you know the entry resolved to the real cipher helper rather
than a same-named impostor from a rotation.

## See also

- [Recipe — superclass-anchored method](superclass-anchored-method.md) —
  the other generic anchor, for classes pinned by a framework parent.
- [Recipe — AIDL stub hooks](aidl-stub-hook.md) — the special case when a
  class hands you an even stronger anchor.
- [Concepts — anchoring](../getting-started/concepts.md#anchoring--how-a-map-entry-survives-rotation).
- [Authoring maps](../maps/authoring.md) — the full discover → edit →
  validate loop.
