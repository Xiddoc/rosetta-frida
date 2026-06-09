# Recipe — hooking a method on a superclass-anchored class

The second generic anchoring pattern, for when the class doesn't embed a
usefully distinctive string but **does** sit under a stable framework
type. A class that extends `android.app.JobService`, implements
`java.lang.Runnable`, or subclasses `android.content.BroadcastReceiver`
keeps that parent across every rotation — because the parent is a
**framework type, not part of the app**, and the obfuscator never
touches it.

So even when the subclass name rotates freely, its inheritance edge to
the framework is fixed. Pin the rotating subclass by its stable parent
via `extends`, and hook the method it overrides.

## The target

A background job, scheduled through `JobScheduler`, whose
`onStartJob(JobParameters)` you want to observe. The subclass name is
obfuscated and rotates every release, but it always
`extends android.app.JobService` and always overrides `onStartJob` —
that signature is dictated by the framework contract.

In the map, pin the entry on its framework parent with `extends`:

```json
"com.example.app.sync.UploadJobService": {
    "obfuscated": "q3",
    "kind": "class",
    "extends": "android.app.JobService",
    "methods": {
        "onStartJob": {
            "obfuscated": "onStartJob",
            "signature": "(Landroid/app/job/JobParameters;)Z"
        }
    }
}
```

Two things to notice:

- **`extends: android.app.JobService` is the anchor.** It names a
  framework class — *not* a key in this map and not something to map. The
  health check uses the inheritance edge to confirm `q3` really is a
  `JobService` subclass, catching a rotation that reassigned `q3` to an
  unrelated class.
- **`onStartJob` is often un-obfuscated.** Methods that **override a
  framework method** usually keep their real name, because the framework
  resolves the override by name — so here `obfuscated` equals the real
  name. (That is not guaranteed; if a build renames it, put the
  obfuscated short name here instead. You still hook by the real name
  `onStartJob`.)

## Finding the class

In jadx, filter for classes whose superclass is `android.app.JobService`
(jadx shows the `extends` clause). On a typical app only a handful of
classes match, so the parent narrows the search space dramatically — that
is the anchor doing its job. Confirm the one you want by its `onStartJob`
body and copy its obfuscated class name (`q3`) into the entry. After a
rotation, re-run the same "subclass of `JobService`" filter and the class
falls out again.

## The hook

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

    rosetta.hook(
        'com.example.app.sync.UploadJobService.onStartJob',
        function (params: unknown) {
            send({ stage: 'onStartJob' });
            // Forward to the original; onStartJob returns boolean
            // (true = work continues on a background thread).
            return rosetta.proceed(params);
        },
    );
});
```

`onStartJob` has a single overload, so the string form resolves directly.
The `rosetta.proceed(params)` call forwards to the original
implementation and returns its `boolean` result, preserving the job's
lifecycle contract.

The tier-2 [`rosetta.use`](../api/tier-2.md) proxy is equivalent if you
prefer to hold the class:

```typescript
const Job = rosetta.use('com.example.app.sync.UploadJobService');
Job.onStartJob.implementation = function (params: unknown) {
    send({ stage: 'onStartJob' });
    return this.onStartJob(params);
};
```

## Why the superclass survives obfuscation

The obfuscator is free to rename `UploadJobService` to `q3` because that
name is internal to the app. It is **not** free to change what `q3`
extends: `android.app.JobService` lives in the Android framework, outside
the app's dex, and the platform's `JobScheduler` will only dispatch to a
genuine `JobService` subclass. Severing or renaming that edge would break
the program, so the inheritance relationship is structurally fixed across
releases — exactly the property an anchor needs.

The same reasoning applies to any framework-imposed parent:
`BroadcastReceiver.onReceive`, `Activity.onCreate`,
`Service.onStartCommand`, `Runnable.run`, `Thread`, `AsyncTask`,
`ContentProvider`, and so on. When a class's role is dictated by a
framework base type, that base type is your anchor.

## What you see at runtime

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=2 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.sync.UploadJobService ← q3 (map)
[rosetta] com.example.app.sync.UploadJobService.onStartJob ← onStartJob (map) (Landroid/app/job/JobParameters;)Z
```

The health check verified `q3`'s parent is `android.app.JobService`, so
the entry resolved to the real job service rather than a rotation
impostor.

## See also

- [Recipe — string-anchored class](string-anchored-class.md) — the other
  generic anchor, for classes pinned by an embedded string literal.
- [Recipe — AIDL stub hooks](aidl-stub-hook.md) — the special case when a
  class hands you an even stronger anchor.
- [Concepts — anchoring](../getting-started/concepts.md#anchoring--how-a-map-entry-survives-rotation).
- [Authoring maps](../maps/authoring.md) — note the "Real-name `extends`
  chains" mistake: a real-name parent must itself be a `classes` key; a
  framework parent like `android.app.JobService` is named directly and
  not mapped.
