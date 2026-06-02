# `rosetta.session(...)`

A **session** is the runtime state that binds a map, an `(app,
version)` pair, a failure policy, and a Resolver. You open one once
per `Java.perform` block and every subsequent tier-1, tier-2, tier-3
call routes through it.

## Signature

```typescript
rosetta.session(options: SessionOptions): Session
```

## `SessionOptions`

```typescript
interface SessionOptions {
    map: RosettaMap | RosettaMapRegistry;
    app?: string;
    version?: string;
    versionCode?: number;                     // authoritative selection key; auto-detected if omitted
    failurePolicy?: 'strict' | 'warn';        // default: 'warn'
    versionMatch?: 'exact' | 'fuzzy';         // default: 'exact'
    trace?: boolean;                          // default: false
    healthCheckThreshold?: number;            // default: 0.8
    skipHealthCheck?: boolean;                // default: false
}
```

### `map`

The map (or registry of maps) to consult. Required.

- A `RosettaMap` (single map) — used as-is. Its `app`/`version` are
  cross-checked against the detected `(app, version)`.
- A `RosettaMapRegistry` (a record of `version → RosettaMap`) —
  the session picks the matching entry by version. With
  `versionMatch: 'exact'` (the default), a missing version throws;
  with `versionMatch: 'fuzzy'`, it falls back to the closest entry.

You build the value in-script: `import` from a JSON file via
`frida-compile` (which inlines it as an object literal), or build it
with [`loadMap(...)`](../maps/format.md#loading-maps-loadmap) in
environments that have filesystem access (typically the CLI, not the
Frida runtime).

### `app`, `version`, `versionCode` { #app-version }

Optional overrides. If `app` and `version` are both omitted, the
session auto-detects via the in-process `PackageManager` chain, which
also reads the authoritative `version_code`:

```typescript
const ActivityThread = Java.use('android.app.ActivityThread');
const app = ActivityThread.currentApplication();
const ctx = app.getApplicationContext();
const pkg = app.getPackageName();
const info = ctx.getPackageManager().getPackageInfo(pkg, 0);
const ver = info.versionName.value;
const code = info.getLongVersionCode();   // API 28+; falls back to int versionCode
```

If you set only one of `app` / `version`, the other is auto-detected.
Mixed override/auto-detect emits a `detect` event with
`source: 'override'`.

`versionCode` is the **authoritative selection key**. When set — or
when auto-detected — it is matched first against a registry's
`version_code` entries; the `version` label is only the fuzzy-match
fallback. A detected `version_code` that mismatches the loaded map's
`version_code` fails (unless `versionMatch: 'fuzzy'`). Set
`versionCode` explicitly only when you need to force a specific build
in tests or when auto-detect can't read it.

### `failurePolicy`

How the Resolver behaves when a real name has no entry in the map:

| Value | Behavior |
|---|---|
| `'strict'` | Throw `ResolveError` immediately at the call site. |
| `'warn'` (default) | Log a `resolve` event with `miss: true` and return a sentinel that throws `UnresolvedAccessError` only if the caller actually tries to use it. |

`strict` is best for CI (any miss is a hard fail; the build breaks).
`warn` is best for production / field deployments (a miss in one
hook does not take down the rest of the script).

The failure policy also gates the health-check escalation: in
`strict` mode, a failed health check throws
`HealthCheckFailedError`; in `warn` mode, it only emits the
`health-check` event.

### `versionMatch`

How strictly the registry-bundle picker matches versions. Note this
only governs the **`version` label** fallback — selection always tries
the authoritative `version_code` first, and a `version_code` match is
always exact (never fuzzy).

| Value | Behavior |
|---|---|
| `'exact'` (default) | After the `version_code` lookup, the registry must contain an entry whose key equals the detected version label. No match → throw. |
| `'fuzzy'` | Fall back to the closest available map by semver distance (`major × 10_000 + minor × 100 + patch`). Ties broken by lower version. Also relaxes the `version_code` mismatch check. |

Fuzzy fallback is intentionally opt-in. Wrong-version maps silently
corrupt hooks; the default failure mode is "tell the user to ship a
map for this version" rather than "guess."

When fuzzy succeeds, the picked map's `version` will *not* equal the
detected version. The session still attaches and runs, but the
diagnostic events make the fuzzy pick visible.

### `trace`

When `true`, every diagnostic event is also written to `console.error`
as a single readable line:

```text
[rosetta] detect auto: com.example.app@3.4.5
[rosetta] map-load com.example.app@3.4.5 schema=2 classes=15
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] com.example.app.IRemoteService$Stub ← aaaa (map)
[rosetta] com.example.app.IRemoteService$Stub.requestTicket ← c (map) (Landroid/os/Bundle;Lbbbb;)V
```

Defaults to `false`. Trace and programmatic [event
subscription](tier-3.md#rosettaevents) coexist — the same event
reaches both.

### `healthCheckThreshold`

The fraction of mapped classes that must resolve via `Java.use(...)`
for the [attach-time health check](#attach-time-health-check) to
pass. Default: `0.8` (80%).

### `skipHealthCheck`

When `true`, suppress the attach-time health check entirely. The
session reports `healthy: true` regardless. Use only in tests or when
your hook does not depend on the mapped classes being live yet
(e.g., late-loaded plugins).

## Return value — `Session`

```typescript
interface Session {
    readonly map: RosettaMap;          // the resolved map (after registry pick)
    readonly app: string;              // detected or supplied
    readonly version: string;          // detected or supplied
    readonly failurePolicy: FailurePolicy;
    readonly healthy: boolean;         // attach-time health-check verdict
}
```

The returned value is a read-only snapshot. You typically do not need
to capture it — the ambient session is set as a side effect and the
subsequent `rosetta.use(...)`, `rosetta.hook(...)`, etc., calls read
through it. Capture it when you want to log the detected version or
when you compose multiple sessions explicitly:

```typescript
const session = rosetta.session({ map });
send({ stage: 'session-opened', app: session.app, version: session.version });
```

## Session lifecycle

```mermaid
sequenceDiagram
    participant U as User script
    participant S as RosettaSession ctor
    participant D as detectAppAndVersion
    participant P as pickMapForVersion
    participant H as runHealthCheck
    participant R as createResolver

    U->>S: rosetta.session({ map, ... })
    S->>D: detect (if no override)
    D-->>S: { app, version, versionCode? }
    Note over S: emit 'detect' event
    S->>P: pick map (version_code first, then label)
    P-->>S: { map, fuzzy?, registryKey? }
    Note over S: cross-check map.app; version_code (or label) acceptable
    Note over S: emit 'map-load' event
    alt skipHealthCheck=false
        S->>H: runHealthCheck(map, threshold)
        H-->>S: { passed, rate, failedEntries }
        Note over S: emit 'health-check' event
        opt failurePolicy=strict AND !passed
            S--xU: throw HealthCheckFailedError
        end
    end
    S->>R: createResolver(map, events, policy)
    R-->>S: Resolver
    S-->>U: Session
```

The session emits four events as it spins up — `detect`,
`map-load`, `health-check`, and `resolve` events as your hooks
exercise the resolver. Subscribe via
[`rosetta.events.on(...)`](tier-3.md#rosettaevents).

## Errors

| Error | When |
|---|---|
| [`MapVersionMismatchError`](../reference/errors.md#mapversionmismatcherror) | The picked map's `(app, version)` does not match the detected `(app, version)`. Includes a hint about `versionMatch: 'fuzzy'` if applicable. |
| [`HealthCheckFailedError`](../reference/errors.md#healthcheckfailederror) | Health check failed and `failurePolicy === 'strict'`. |
| `Error` ("no map for version …") | Registry has no exact-version entry and `versionMatch !== 'fuzzy'`. |
| `Error` ("registry is empty") | Registry has no entries at all. |
| `Error` ("cannot auto-detect …") | Auto-detect ran but `globalThis.Java` is unavailable. |

`MapVersionMismatchError` and `HealthCheckFailedError` are
[`RosettaError`](../reference/errors.md#rosettaerror) subclasses, so
broad catches work:

```typescript
try {
    rosetta.session({ map });
} catch (e) {
    if (e instanceof RosettaError) {
        send({ stage: 'session-failed', err: e.message });
        return;
    }
    throw e;
}
```

## Attach-time health check

Before any user hook runs, the session iterates the loaded map's
classes and verifies each one resolves via `Java.use(obfName)`. For
classes with `aidl_descriptor`, it additionally checks
`klass.$aidlDescriptor` matches. For classes with `anchors`, it
checks each anchor string is in `klass.$anchorStrings`.

The fraction `passing / total` is compared against
`healthCheckThreshold` (default `0.8`):

```text
[rosetta] health-check PASS rate=100.0% threshold=80.0% failures=0
[rosetta] health-check FAIL rate=65.0% threshold=80.0% failures=4
```

On failure:

- In `failurePolicy: 'warn'` mode, the session emits the event and
  proceeds. Your hooks run, but you have been warned in writing.
- In `failurePolicy: 'strict'` mode, the session throws
  `HealthCheckFailedError` and your script halts. The error carries
  `rate`, `threshold`, and the full list of `failedEntries`.

Subscribe programmatically:

```typescript
rosetta.events.onType('health-check', (e) => {
    if (!e.passed) {
        send({
            stage: 'health-check-failed',
            rate: e.rate,
            failed: e.failedEntries,
        });
    }
});
```

See [Events reference](../reference/events.md#healthcheckevent) for
the full event shape.

## Switching sessions

`rosetta.session(...)` replaces the ambient session. Subsequent
calls run against the new session.

```typescript
rosetta.session({ map: mapForA });
// ... tier-1/2/3 calls against mapForA ...

rosetta.session({ map: mapForB });
// ... tier-1/2/3 calls against mapForB ...
```

Already-installed hooks keep running with whichever session installed
them — `rosetta.hook(...)` captures the session's resolver at install
time. The switch only affects new calls.

For two simultaneous sessions, use the explicit composition form
(see [Advanced composition](overview.md#advanced-composition)).
