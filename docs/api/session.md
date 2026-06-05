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
    enforceSigner?: boolean;                  // default: true (secure default)
    targetPolicy?: TargetPolicy;              // default: built-in denylist, fail-closed
}

interface TargetPolicy {
    denyPrefixes?: readonly string[];         // augments (or replaces) the built-in denylist
    mergeDenylist?: boolean;                  // default: true (augment); false replaces
    allow?: readonly string[];                // exact-FQN escape hatch
    appNamespaceLabels?: number;              // default: 2 (e.g. com.example)
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

### `enforceSigner`

Whether to enforce the map's signing-certificate authenticity guard
(`signer_sha256`) at attach time. Default `true` — the secure default.

When the loaded map carries a `signer_sha256` and `enforceSigner` is
not `false`, the session reads the running app's signing certificate
**in-process** (see [Signer enforcement](#signer-enforcement)),
SHA-256's it, and **fails closed** with
[`SignerMismatchError`](../reference/errors.md#signermismatcherror) if
no live signer matches. When the map has no `signer_sha256`, the check
is skipped regardless of this flag (and no `signer-check` event is
emitted).

Set to `false` to opt out — e.g. when attaching to a locally re-signed
debug build of an app whose map was captured from the production-signed
APK.

**Cross-client contract.** `enforceSigner: false` is the Frida-idiomatic
equivalent of the Kotlin `rosetta-xposed` client's
`RosettaXposed.fromMapUnverified` construction path: both select the
**unverified** path that skips the signer guard entirely. Frida has no
constructor-overload idiom, so the opt-out is expressed as a typed
`SessionOptions` flag instead; opted-out (`enforceSigner: false`) ==
the unverified path. With the flag on (the default) and a valid
`signer_sha256` present, enforcement is unconditional and fail-closed on
both clients, with a matching error taxonomy (`MalformedSignerError` /
`MissingSignerError` / `SignerMismatchError`).

### `targetPolicy`

The **target-namespace guard** (RFC 0001 C1). A community map maps a
real name to an arbitrary obfuscated string, and the runtime feeds that
string verbatim into `Java.use(...)`. A malicious or simply wrong map
could therefore redirect a hook at a sensitive framework class —
`java.lang.Runtime`, `android.app.*`, a `dagger.internal.Provider`, etc.
This guard confines a resolution **target** (the FQN passed to
`Java.use`: a resolved class `obfName`, a method/field's owning class,
and the obfuscated output of arg-type translation) to the app's own /
package-local namespace, and **throws**
[`TargetPolicyError`](../reference/errors.md#targetpolicyerror) before
the `Java.use` call for anything else. **Strict only — there is no
warn-and-proceed mode.**

Omitting `targetPolicy` is **fail-closed**: the built-in
`DEFAULT_DENY_PREFIXES`, an empty allowlist, and 2 app-namespace labels
apply, so a map pointing a hook at `java.lang.Runtime` is rejected with
no configuration needed.

Decision order (first match wins):

1. **`allow`** exact-FQN match → ALLOW (the escape hatch for legitimate
   framework hooks; exact, case-sensitive, against the normalized
   element FQN).
2. top-level prefix on the **reserved denylist** → DENY (`reason:
   'reserved-namespace'`), even if it also matches the app prefix.
3. **package-local** (no `.` in the namespace) → ALLOW (the common case
   — obfuscators emit single-letter / short names).
4. starts with the **app's own prefix** (first `appNamespaceLabels`
   labels of the app package, dot-boundary) → ALLOW.
5. else → DENY (`reason: 'foreign-namespace'`).

Normalization strips array markers (`[`, `L…;`, `…[]`) down to the
element class FQN; primitives and `void` are always allowed (not
loadable); nested classes split the namespace on `.` only
(`com.example.app.Foo$Bar` is app-owned; `android.os.Foo$Bar` is
denied). Matching is case-sensitive.

`denyPrefixes` augments the built-in list by default; set
`mergeDenylist: false` to **replace** it entirely (use with care — that
re-opens framework namespaces). The default denylist:

```
java.  javax.  jdk.  sun.  com.sun.  dalvik.  android.  androidx.
com.android.  kotlin.  kotlinx.  dagger.  com.google.android.  libcore.
org.apache.harmony.
```

**Cross-client contract.** This is the Frida twin of the Kotlin
`rosetta-xposed` `TargetGuard`; both clients share the same decision
order and the same `DEFAULT_DENY_PREFIXES` (value-for-value) so they
accept/reject the same maps.

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
    participant G as checkSigner
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
    opt map.signer_sha256 set AND enforceSigner!=false
        S->>G: checkSigner(map.signer_sha256)
        G-->>S: { passed, expected, actual, source }
        Note over S: emit 'signer-check' event
        opt !passed
            S--xU: throw SignerMismatchError
        end
    end
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

The session emits a sequence of events as it spins up — `detect`,
`map-load`, an optional `signer-check` (only when the map carries a
`signer_sha256` and enforcement is on), `health-check`, and `resolve`
events as your hooks exercise the resolver. Subscribe via
[`rosetta.events.on(...)`](tier-3.md#rosettaevents).

## Errors

| Error | When |
|---|---|
| [`MapVersionMismatchError`](../reference/errors.md#mapversionmismatcherror) | The picked map's `(app, version)` does not match the detected `(app, version)`. Includes a hint about `versionMatch: 'fuzzy'` if applicable. |
| [`SignerMismatchError`](../reference/errors.md#signermismatcherror) | The map carries a valid `signer_sha256`, enforcement is on, the app presents signer(s), and none matched. Carries `expected` + sorted `actual` hashes. Override with `enforceSigner: false`. |
| [`MalformedSignerError`](../reference/errors.md#malformedsignererror) | The map's `signer_sha256` is not 64 hex chars after normalization (author error). Raised before the live signers are read. |
| [`MissingSignerError`](../reference/errors.md#missingsignererror) | The map carries a valid `signer_sha256`, enforcement is on, but the live app exposes no readable signing certificate. Override with `enforceSigner: false`. |
| [`TargetPolicyError`](../reference/errors.md#targetpolicyerror) | A resolved target FQN is forbidden by the namespace guard (`reason: 'reserved-namespace' \| 'foreign-namespace'`). Thrown at resolution time, before any `Java.use`. Strict only. Allow a legit framework hook via `targetPolicy.allow`. |
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

## Signer enforcement

When the loaded map carries a `signer_sha256` (the SHA-256 of the APK
**signing certificate**, not the APK bytes) and `enforceSigner` is not
`false`, the session verifies the running app was actually signed by
the expected party **before** any hook installs. This is the
authenticity half of the "right map for the right app" guarantee
(RFC 0001 Decision 3): it stops a map from being silently applied to a
**repackaged or spoofed** build that merely shares the same
`version_code`.

The read mirrors the auto-detect chain but asks `PackageManager` for
signing info instead of versions:

```typescript
const pm = ctx.getPackageManager();
// API 28+ — the v2/v3 signing block:
let info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
let signers = info.signingInfo.value.getApkContentsSigners();
// pre-28 fallback — the deprecated signatures array:
if (!signers) signers = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures.value;
// each Signature → SHA-256(cert bytes) → lowercase, colon-free hex
```

Behaviour:

- **Match** — at least one live signer's SHA-256 equals the map's
  `signer_sha256`. The session emits a passing `signer-check` event and
  proceeds.
- **Mismatch** — no live signer matches. The session emits a failing
  `signer-check` event and **fails closed** with
  [`SignerMismatchError`](../reference/errors.md#signermismatcherror)
  (carrying the `expected` hash and every `actual` live hash). Unlike
  the health check, this is *not* gated by `failurePolicy` — an
  authenticity failure always halts, because the whole point is to
  refuse a map that does not belong to the running app.
- **Map hash malformed** — the map's `signer_sha256` is not 64 lowercase
  hex characters after normalization. This is an **author error**, not a
  spoof, so it fails closed with
  [`MalformedSignerError`](../reference/errors.md#malformedsignererror)
  *before* the live signers are even read (rather than a misleading
  mismatch).
- **App signer unreadable** — the map has a valid `signer_sha256` but the
  running app exposes no readable signing certificate. Fails closed with
  [`MissingSignerError`](../reference/errors.md#missingsignererror).
- **Field absent** — the map has no `signer_sha256`. The check is
  skipped and no `signer-check` event is emitted.
- **Opted out** — `enforceSigner: false` (the equivalent of the Kotlin
  client's unverified construction path). Same as field-absent: skipped
  and silent.

**Multiple signers.** An APK may be signed by more than one certificate
(e.g. a signing-key rotation lineage). The check hashes every signer
and accepts a match on **any** one — requiring all to match would
reject legitimate key-rotation builds, and a single trusted-signer
match already establishes "this build was signed by the expected
party."

**Normalization.** Both the map's `signer_sha256` and the live hashes
are normalized before comparison — lowercased, with colon separators
stripped and *surrounding* whitespace trimmed — so a map authored as
`AB:CD:...` compares equal to the runtime bytes. Interior whitespace is
deliberately **not** stripped, so a garbled hash survives to fail the
64-hex well-formedness check (rejected as `MalformedSignerError`); this
matches the Kotlin client so malformed input is rejected identically on
both. The reported `actual` live-signer hashes are **sorted**, so
mismatch reports are deterministic and align with the Kotlin client's
sorted-set rendering.

```typescript
rosetta.events.onType('signer-check', (e) => {
    if (!e.passed) {
        send({ stage: 'signer-mismatch', expected: e.expected, actual: e.actual });
    }
});
```

See [Events reference](../reference/events.md#signercheckevent) for the
full event shape.

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
