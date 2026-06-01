# Quick start

The smallest possible working hook end-to-end. By the end of this page
you will have:

1. A map describing the obfuscated names for one class in one app
   version.
2. A TypeScript hook that targets that class by its real name.
3. A compiled bundle you can load with `frida -U -l hook.bundle.js`.
4. Verification that the bundle round-trips through `rosetta inspect`.

The example uses the canonical anonymized sample app
`com.example.app` whose map ships in this repo at
`maps/com.example.app/3.4.5.json` (a 15-class example covering
every feature of the schema).

## 1. Scaffold or import the map

For real work, start with `rosetta init` and fill in entries:

```sh
npx rosetta init com.example.app 3.4.5
# wrote maps/com.example.app/3.4.5.json
```

For this tutorial, use the ready-made sample map at
`maps/com.example.app/3.4.5.json`. It contains:

```json
{
    "schema_version": 2,
    "app": "com.example.app",
    "version": "3.4.5",
    "version_code": 30405,
    "captured_at": "2026-05-13",
    "classes": {
        "com.example.app.IRemoteService$Stub": {
            "obfuscated": "aaaa",
            "kind": "aidl_stub",
            "aidl_descriptor": "com.example.app.IRemoteService",
            "methods": {
                "requestTicket": [
                    {
                        "obfuscated": "c",
                        "signature": "(Landroid/os/Bundle;Lbbbb;)V",
                        "aidl_txn": 2
                    }
                ]
            }
        }
    }
}
```

See [Maps — format reference](../maps/format.md) for the full schema.

## 2. Write the hook

Create `hook.ts`:

```typescript
import sampleMap from './maps/com.example.app/3.4.5.json' with { type: 'json' };
import { rosetta, type RosettaMap } from 'rosetta-frida';

const map = sampleMap as unknown as RosettaMap;

Java.perform(() => {
    rosetta.session({
        map,
        // No `app` / `version` — auto-detect via
        // ActivityThread.currentApplication().getPackageManager().
        trace: true,
        failurePolicy: 'warn',
    });

    rosetta.hook(
        'com.example.app.IRemoteService$Stub.requestTicket',
        function (bundle: unknown, callback: unknown) {
            send({ stage: 'requestTicket', bundleType: typeof bundle });
            return rosetta.proceed(bundle, callback);
        },
    );
});
```

That's the whole hook. The class is `IRemoteService$Stub` (its real
name) — at runtime rosetta looks that up in the map and reaches into
`Java.use('aaaa')` for you.

!!! tip "Why `Java.perform`?"
    Frida requires Java APIs to run inside `Java.perform(...)`.
    rosetta's resolver does not call `Java.use` until you reach for a
    class or install a hook, so the wrapping is your responsibility.
    Match the surrounding Frida idiom.

## 3. Compile the bundle

```sh
npx frida-compile hook.ts -o hook.bundle.js
```

The resulting `hook.bundle.js` is a single self-contained script. The
imported `.json` sibling (produced from `.json` via `rosetta convert`)
is inlined by `frida-compile` as a JavaScript object literal — no
filesystem dependency at hook-execution time.

!!! warning "Marker block is not embedded automatically yet"
    `rosetta inspect`, `extract`, and `patch` operate on a marker
    block surrounding the embedded map. V1.0 expects you to embed it
    manually (one-time, on the imported map) until the
    [`frida-compile` plugin](../recipes/frida-compile-integration.md)
    ships. See [Marker block — manual embedding](../maps/marker-block.md#manual-embedding)
    for the recipe.

## 4. Run

```sh
frida -U -l hook.bundle.js com.example.app
```

Or via your existing controller (Python `frida`, `frida-node`,
`frida-cli`) — the bundle is a normal Frida script.

With `trace: true` in the session options, you will see lines on
stderr like:

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=1 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.IRemoteService$Stub ← aaaa (map)
[rosetta] com.example.app.IRemoteService$Stub.requestTicket ← c (map) (Landroid/os/Bundle;Lbbbb;)V
```

When the app makes its first call to `requestTicket`, the hook fires
and you get a `send({ stage: 'requestTicket', ... })` message on the
host side.

## 5. (Optional) Embed the marker block and inspect

Once you have wired up the manual marker-block embedding step
([recipe](../recipes/frida-compile-integration.md#manual-marker-wrapping)),
your bundle becomes self-describing:

```sh
$ npx rosetta inspect hook.bundle.js
com.example.app@3.4.5, schema_version 1, 15 classes
```

And you can swap maps without recompiling:

```sh
$ npx rosetta patch hook.bundle.js --map maps/com.example.app/3.5.0.json
patch: wrote hook.bundle.js (in place)

$ npx rosetta inspect hook.bundle.js
com.example.app@3.5.0, schema_version 1, 15 classes
```

The hook source did not change. The user-visible class names did not
change. Only the embedded map did.

That is the whole story.

## Where to go next

- [Concepts](concepts.md) — real vs obfuscated names, sessions, the
  rotation problem.
- [API overview](../api/overview.md) — the three tiers and when to
  use each.
- [Authoring maps](../maps/authoring.md) — the full workflow for
  creating a map for a new app or version.
- [Sample hook walkthrough](../recipes/aidl-stub-hook.md) — annotated
  tour of the canonical example hook.
