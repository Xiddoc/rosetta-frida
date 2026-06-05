# Errors

Every error thrown by rosetta-frida extends `RosettaError`. Consumers
can do `catch (e) { if (e instanceof RosettaError) ... }` to handle
library errors uniformly. Each subclass carries structured context so
failure reports are actionable without parsing message strings.

All error classes are exported from the package root:

```typescript
import {
    RosettaError,
    ResolveError,
    AmbiguousOverloadError,
    MapValidationError,
    JsonParseError,
    MapVersionMismatchError,
    SignerMismatchError,
    HealthCheckFailedError,
    MarkerBlockError,
    UnresolvedAccessError,
} from 'rosetta-frida';
```

## `RosettaError`

Base class. Plain `Error` subclass; the name is set to the concrete
subclass via `new.target.name`.

```typescript
class RosettaError extends Error {
    constructor(message: string);
}
```

Catch this when you want to handle "anything rosetta-frida threw":

```typescript
try {
    rosetta.session({ map });
    rosetta.hook('Foo.bar', fn);
} catch (e) {
    if (e instanceof RosettaError) {
        send({ stage: 'rosetta-failure', message: e.message, kind: e.name });
        return;
    }
    throw e;
}
```

## `ResolveError`

A real name has no entry in the loaded map (and V1 has no discovery,
so the failure is terminal).

```typescript
class ResolveError extends RosettaError {
    readonly realName: string;
    readonly app: string;
    readonly version: string;
    readonly kind: 'class' | 'method' | 'field' | 'type';
    readonly classScope?: string;
}
```

| Field | Description |
|---|---|
| `realName` | The real name that didn't resolve. |
| `app`, `version` | The session's `(app, version)` — to make the error self-locating. |
| `kind` | What we were trying to resolve. |
| `classScope` | For methods/fields, the real class name. Undefined for class-level errors. |

**Example message:** `rosetta-frida: cannot resolve class
'com.example.app.IFoo' — not in the map for com.example.app@3.4.5.`

**When fired:**

- `rosetta.use('com.example.app.NotInMap')` in `failurePolicy:
  'strict'`.
- `rosetta.map.resolveClass('com.example.app.NotInMap')` (always —
  tier 3 is strict regardless of policy).
- `rosetta.hook('com.example.app.IFoo.bar', fn)` when `IFoo` or `bar`
  is not in the map.
- `rosetta.field(instance, 'someField')` when `someField` is not
  mapped on the instance's class.

## `AmbiguousOverloadError`

A method real-name has multiple overloads in the map and the user
didn't disambiguate.

```typescript
class AmbiguousOverloadError extends RosettaError {
    readonly realName: string;
    readonly classScope: string;
    readonly overloadCount: number;
}
```

| Field | Description |
|---|---|
| `realName` | The method real name (e.g. `'requestTicket'`). |
| `classScope` | The class the method lives on. |
| `overloadCount` | How many overloads exist in the map. |

**Example message:** `rosetta-frida: 2 overloads exist for
IRemoteService$Stub.requestTicket; pass `args` to disambiguate.`

**When fired:**

- `rosetta.hook('Foo.bar', fn)` (string form) where `bar` has
  multiple overloads in the map.
- `rosetta.map.resolveMethod('Foo', 'bar')` (without `argTypes`)
  where `bar` has multiple overloads.

**Fix:** use the object form of `rosetta.hook(...)` with
disambiguating `args`, or pass `argTypes` to `resolveMethod`.
See [Overloaded methods recipe](../recipes/overloaded-methods.md).

## `MapValidationError`

The loaded map is structurally invalid (schema check failure).

```typescript
class MapValidationError extends RosettaError {
    readonly issues: readonly { path: string; message: string }[];
}
```

| Field | Description |
|---|---|
| `issues` | Array of `{ path, message }` — one per schema violation. The path is a dotted JSON path into the map. |

**Example message:** `rosetta-frida: invalid map`

with `issues`:

```text
[
  { path: 'schema_version', message: 'required' },
  { path: 'classes.com.example.app.Foo.obfuscated', message: 'required' },
  { path: 'classes.com.example.app.Bar.methods.baz.signature', message: 'must match /\\(.*\\)[^()]+/' }
]
```

**When fired:**

- `loadMap('./x.json')` when the parsed object doesn't satisfy the
  Zod schema.
- `yamlToMap(...)` / `tsModuleToMap(...)` — the converters all run
  the same validator.
- `rosetta validate <map>` CLI when the file fails the check.

## `JsonParseError`

The strict-JSON source can't be parsed (this includes comments and
trailing commas, which are not valid JSON).

```typescript
class JsonParseError extends RosettaError {
    readonly line: number;
    readonly column: number;
}
```

| Field | Description |
|---|---|
| `line` | 1-indexed line of the syntax error. |
| `column` | 1-indexed column. |

**Example message:** `Invalid JSON: Unexpected token ... (line 12,
column 4)`

**When fired:**

- `parseJson('...')` on syntactically invalid JSON.
- `loadMap('./x.json')` on a JSON file that fails to parse.

## `MapVersionMismatchError`

The loaded map's `(app, version)` doesn't match the running app
session's detected `(app, version)`.

```typescript
class MapVersionMismatchError extends RosettaError {
    readonly detectedApp: string;
    readonly detectedVersion: string;
    readonly mapApp: string;
    readonly mapVersion: string;
}
```

| Field | Description |
|---|---|
| `detectedApp`, `detectedVersion` | What the session detected (or user-supplied). |
| `mapApp`, `mapVersion` | What the loaded map says. |

**Example message:** `rosetta-frida: loaded map is for
com.example.app@3.4.5 but the running process is
com.example.app@3.5.0. Provide a map for 3.5.0 or pass
versionMatch: 'fuzzy'.`

**When fired:**

- `rosetta.session({ map })` when the map's `app`/`version` doesn't
  match the detected pair (and `versionMatch` is not `'fuzzy'`).

## `SignerMismatchError`

The loaded map carries a `signer_sha256`, enforcement is on
(`enforceSigner !== false`), and **no** live signing certificate
matched the expected hash. This is a fail-closed authenticity guard
(RFC 0001 Decision 3) — it is **not** gated by `failurePolicy`; an
authenticity failure always halts.

```typescript
class SignerMismatchError extends RosettaError {
    readonly app: string;
    readonly expected: string;
    readonly actual: readonly string[];
}
```

| Field | Description |
|---|---|
| `app` | The session's detected/supplied app package name. |
| `expected` | The map's `signer_sha256`, normalized (lowercase, no colons). |
| `actual` | Every live signing-certificate SHA-256 observed (normalized). May contain more than one when the app has multiple signers. |

**Example message:** `rosetta-frida: signer mismatch for
com.example.app — the loaded map (com.example.app@3.4.5) expects
signing-certificate SHA-256 ab… , but the running app is signed by
[cd…]. Refusing to apply a map to an app it was not captured for (pass
enforceSigner: false to override).`

**When fired:**

- `rosetta.session({ map })` when the map has a `signer_sha256`, the
  flag is on, and the live signer(s) don't match.

The check is **skipped** (and no error is possible) when the map has no
`signer_sha256` or when `enforceSigner: false`. A match on **any** one
of several live signers passes. See
[API · Session · Signer enforcement](../api/session.md#signer-enforcement).

## `HealthCheckFailedError`

The attach-time health check failed and `failurePolicy === 'strict'`.

```typescript
class HealthCheckFailedError extends RosettaError {
    readonly rate: number;
    readonly threshold: number;
    readonly failedEntries: readonly string[];
}
```

| Field | Description |
|---|---|
| `rate` | Fraction of mapped classes that passed (e.g. `0.65`). |
| `threshold` | Configured threshold (default `0.8`). |
| `failedEntries` | Real names of the classes that failed to resolve. |

**Example message:** `rosetta-frida: health check failed for
com.example.app@3.4.5 — rate=65.0% threshold=80.0%, 4 entry/entries
did not resolve.`

**When fired:**

- `rosetta.session({ map, failurePolicy: 'strict' })` when the
  health check rate falls below the threshold.

In `failurePolicy: 'warn'` (the default), the same failure emits a
`health-check` event with `passed: false` but doesn't throw.

## `MarkerBlockError`

A marker block can't be located or parsed in a compiled bundle.

```typescript
class MarkerBlockError extends RosettaError {
    readonly bundlePath?: string;
}
```

**Example messages:**

- `rosetta-frida: no rosetta-frida marker block found in bundle`
- `rosetta-frida: marker block found but no \`__rosetta_map = ...\`
  declaration inside`
- `rosetta-frida: marker block payload doesn't terminate with a \`;\`
  before the END marker`
- `rosetta-frida: marker block payload is not valid JSON: ...`

**When fired:**

- `parseMarkerBlock(bundleSrc)` when the bundle has no marker block,
  has a malformed one, or its payload is unparseable.
- `patchMarkerBlock(bundleSrc, newMap)` when the bundle has no
  existing marker block to replace.
- `rosetta extract`, `rosetta patch`, `rosetta inspect` CLI when any
  of the above bubble up.

## `UnresolvedAccessError`

A `warn`-mode sentinel was actually used.

```typescript
class UnresolvedAccessError extends RosettaError {
    readonly realName: string;
}
```

| Field | Description |
|---|---|
| `realName` | The real name whose lookup originally missed. |

**Example message:** `rosetta-frida: cannot use sentinel for
'com.example.app.IFoo' — name is not in the map for
com.example.app@3.4.5.`

**When fired:**

- A `warn`-policy session returned a sentinel for a missed lookup,
  and downstream code tried to use it. The first use throws.

The original miss was logged as a `resolve` event with `miss: true`
at the time of lookup. The `UnresolvedAccessError` is the deferred
crash. To find the original site, listen for `miss` events at the
session level.

See `isSentinel(value)` and `makeSentinel(realName)` for the
sentinel primitives.

## Error-handling patterns

### Single broad catch

```typescript
import { RosettaError } from 'rosetta-frida';

try {
    rosetta.session({ map });
    rosetta.hook('Foo.bar', fn);
} catch (e) {
    if (e instanceof RosettaError) {
        send({ stage: 'rosetta-error', name: e.name, message: e.message });
        return;
    }
    throw e;   // not a rosetta error — let it propagate
}
```

### Specific handling

```typescript
import {
    ResolveError,
    AmbiguousOverloadError,
    HealthCheckFailedError,
} from 'rosetta-frida';

try {
    rosetta.hook('Foo.bar', fn);
} catch (e) {
    if (e instanceof AmbiguousOverloadError) {
        // Auto-disambiguate by inspecting tier 3.
        const m = rosetta.map.extract().classes.Foo?.methods?.bar;
        const overloads = Array.isArray(m) ? m : m ? [m] : [];
        // ... reinstall per-overload ...
        return;
    }
    if (e instanceof ResolveError) {
        send({ stage: 'miss', name: e.realName, scope: e.classScope });
        return;
    }
    throw e;
}
```

### Catching health-check failures in `strict`

```typescript
try {
    rosetta.session({ map, failurePolicy: 'strict' });
} catch (e) {
    if (e instanceof HealthCheckFailedError) {
        send({
            stage: 'health-check-failed',
            rate: e.rate,
            failed: e.failedEntries,
        });
        // Continue with warn policy as a fallback?
        rosetta.session({ map, failurePolicy: 'warn' });
        return;
    }
    throw e;
}
```
