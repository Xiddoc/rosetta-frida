# Recipe — debugging

How to debug rosetta-frida hooks when something goes wrong. The
library's diagnostic surface is structured and exhaustive — most
problems surface as a specific error with a clear message before
they cascade into mystery `null`/`undefined` failures.

## Trace mode

The single most useful debugging tool. Set `trace: true` on the
session:

```typescript
rosetta.session({ map, trace: true });
```

Every diagnostic event prints to `console.error` as a single readable
line:

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=1 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.IRemoteService$Stub ← aaaa (map)
[rosetta] com.example.app.IRemoteService$Stub.requestTicket ← c (map) (Landroid/os/Bundle;Lbbbb;)V
[rosetta] com.example.app.IServiceCallback ← bbbb (map)
```

Each line tells you what was resolved, where it came from
(`cache`, `map`, `override`), and (for methods) the picked overload's
signature.

A miss appears as:

```text
[rosetta] com.example.app.IUnknown ← MISS
```

## Programmatic event subscription

Trace mode is for development. For programmatic surfacing —
e.g. failing CI on misses, or aggregating diagnostics to a host
controller — subscribe via `rosetta.events`:

```typescript
rosetta.events.onType('resolve', (e) => {
    if (e.miss) {
        send({ alert: 'unresolved', name: e.name, scope: e.classScope });
    }
});

rosetta.events.onType('health-check', (e) => {
    if (!e.passed) {
        send({ alert: 'health-check-failed', rate: e.rate, failed: e.failedEntries });
    }
});

rosetta.events.onType('detect', (e) => {
    send({ stage: 'detect', app: e.app, version: e.version, source: e.source });
});

rosetta.events.onType('map-load', (e) => {
    send({ stage: 'map-load', classes: e.classCount });
});
```

Trace and programmatic subscription **coexist** — the same event
reaches both.

## Common errors and what they mean

### `ResolveError`

> "rosetta-frida: cannot resolve class `com.example.app.IFoo` —
> not in the map for `com.example.app@3.4.5`."

The real name isn't in the loaded map. Two common causes:

1. **Typo in the real name.** Check your hook source against the
   map's class keys.
2. **Map is incomplete.** Add the entry; or use `rosetta init` for
   a class scaffold and fill it in.

For method/field misses, the error tells you both the class scope
and the missing member name. See
[`ResolveError`](../reference/errors.md#resolveerror) for the full
structured fields.

### `AmbiguousOverloadError`

> "rosetta-frida: 2 overloads exist for `BlobCache.put`; pass `args`
> to disambiguate."

You used the string form of `rosetta.hook` on a multi-overload
method. Switch to the object form with `args` to disambiguate. See
[Overloaded methods recipe](overloaded-methods.md).

### `MapValidationError`

> "rosetta-frida: invalid map"

The map file fails the schema check. The error carries `issues: { path,
message }[]` with one entry per problem:

```typescript
catch (e) {
    if (e instanceof MapValidationError) {
        for (const issue of e.issues) {
            console.error(`  at ${issue.path}: ${issue.message}`);
        }
    }
}
```

Run [`rosetta validate <map>`](../cli/validate.md) to surface these
on the CLI before the runtime sees them.

### `MapVersionMismatchError`

> "rosetta-frida: loaded map is for `com.example.app@3.4.5` but
> the running process is `com.example.app@3.4.6`. Provide a map
> for `3.4.6` or pass `versionMatch: 'fuzzy'`."

The detected `(app, version)` doesn't match the loaded map's. Three
fixes:

1. **Author a map for the running version.** The canonical answer.
2. **Pass an override**: `rosetta.session({ map, version: '3.4.5' })`
   — forces the session to behave as if `3.4.5` is running. Use
   only for testing or known-compatible cases.
3. **Enable fuzzy version matching** on a registry bundle:
   `versionMatch: 'fuzzy'`. See
   [Multi-version bundle recipe](multi-version-bundle.md).

### `HealthCheckFailedError`

> "rosetta-frida: health check failed for `com.example.app@3.4.5` —
> rate=65.0% threshold=80.0%, 4 entry/entries did not resolve."

Health check failed and `failurePolicy === 'strict'`. The error
carries `rate`, `threshold`, and the full `failedEntries: string[]`
list. Either:

1. **Audit the failed entries.** Each one's obfuscated name either
   rotated or never existed. Update the map.
2. **Lower the threshold** for legitimate reasons (e.g. some classes
   are loaded later by the app): `healthCheckThreshold: 0.5`.
3. **Switch to `warn` policy** for development:
   `failurePolicy: 'warn'`. The session still emits the event but
   doesn't throw.

### `JsonParseError`

> "rosetta-frida: JSON parse error at line 12 col 4: unexpected
> token"

The JSON source doesn't parse. The error carries `line` and
`column`. Find the location, fix the syntax (usually a missing
comma or quote), retry.

### `MarkerBlockError`

> "rosetta-frida: no rosetta-frida marker block found in bundle"

The bundle doesn't have a marker block. Either:

1. **The build pipeline didn't embed one.** Add the manual marker-
   wrapping step (see
   [frida-compile integration recipe](frida-compile-integration.md)).
2. **The minifier stripped the marker.** Check that your minifier
   preserves `/*! ... */` "important" comments.

Other `MarkerBlockError` cases — payload not valid JSON, no `const
__rosetta_map = ...` declaration — usually mean someone hand-edited
the compiled bundle. Use `rosetta patch` instead of editing.

### `UnresolvedAccessError`

> "rosetta-frida: cannot use sentinel for `com.example.app.IFoo`
> — name is not in the map for `com.example.app@3.4.5`."

You're in `failurePolicy: 'warn'` mode and the warning sentinel
escaped into a usage site. The miss was logged earlier; this is the
deferred crash.

Either fix the underlying miss (add the entry to the map) or switch
to `'strict'` mode so the failure surfaces at the call site instead
of later.

## Sentinels in `'warn'` mode

In `failurePolicy: 'warn'`, a miss returns a sentinel proxy instead
of throwing immediately. The sentinel records the unresolved name
and throws `UnresolvedAccessError` only when you actually use it.

Trade-offs:

- **Pro.** A miss in one hook doesn't take down the rest of the
  script. The script keeps running; other hooks fire normally.
- **Con.** The error surfaces *later*, at the use site, which can
  be confusing if the miss happened in a different module.

`isSentinel(value)` lets you check whether something is a sentinel
before using it — useful for adaptive logic:

```typescript
import { isSentinel } from 'rosetta-frida';

const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
if (isSentinel(Stub)) {
    send({ stage: 'skip', reason: 'IRemoteService$Stub not in map' });
    return;
}
// ... safe to use Stub ...
```

## Inspecting what the map says

When you don't know whether a name is mapped, query tier 3:

```typescript
try {
    const cls = rosetta.map.resolveClass('com.example.app.IRemoteService$Stub');
    send({ stage: 'mapped', real: cls.realName, obf: cls.obfName, kind: cls.entry.kind });
} catch (e) {
    if (e instanceof ResolveError) {
        send({ stage: 'unmapped', name: 'com.example.app.IRemoteService$Stub' });
    } else {
        throw e;
    }
}
```

Or dump the whole map:

```typescript
const map = rosetta.map.extract();
send({ stage: 'map-summary', app: map.app, version: map.version, classes: Object.keys(map.classes) });
```

## Inspecting bundles offline

Before running a bundle, audit it:

```sh
$ npx rosetta inspect hook.bundle.js
com.example.app@3.4.5, schema_version 1, 15 classes

$ npx rosetta extract hook.bundle.js -o snapshot.json
$ jq '.classes | keys' snapshot.json
[
  "com.example.app.IRemoteService$Stub",
  "com.example.app.IServiceCallback",
  ...
]
```

If the bundle's app/version doesn't match the device you intend to
target, you'll spot it before you attach.

## Debugging the health check

Verbose mode for the health check — see every failed entry:

```typescript
rosetta.events.onType('health-check', (e) => {
    if (!e.passed) {
        for (const name of e.failedEntries) {
            send({ stage: 'failed-entry', name });
        }
    }
});
```

For each failed entry, look at the map's `ClassEntry` to see what
was expected:

```typescript
const failed = ['com.example.app.IFoo'];
for (const name of failed) {
    const entry = rosetta.map.extract().classes[name];
    send({
        stage: 'failed-detail',
        name,
        obf: entry?.obfuscated,
        kind: entry?.kind,
        descriptor: entry?.aidl_descriptor,
    });
}
```

Then jadx the obfuscated class and confirm it's actually the one you
expected. If not — obfuscation rotated, update the map.

## When the hook itself is wrong

Sometimes the map is right but the hook is wrong:

1. **Frida silently ignores the implementation.** Usually a typo in
   the real name passed to `rosetta.hook(...)`. Compare against your
   map's keys.
2. **The hook fires but on the wrong overload.** Inspect at runtime
   with `this.<method>.overloads` to confirm you got the one you
   wanted.
3. **`rosetta.proceed(...)` returns `undefined` when you expected a
   value.** You're at the top of the chain and the original method
   was already replaced (or never existed). Drop to tier 3 and call
   the wrapper directly.

## Where to file bugs

Pre-V1.0 release the library lives in a private repo. After release,
issues will be tracked on the GitHub project. Include in any report:

- The error message (full, with stack if available).
- The session options you used (omit `map` itself if it's large).
- Trace output (`trace: true`) up to the point of failure.
- A minimal reproducer if you can extract one.

## Related

- [Errors reference](../reference/errors.md) — every error class.
- [Events reference](../reference/events.md) — every diagnostic
  event.
- [Session API](../api/session.md) — failure policy, trace mode,
  health check controls.
