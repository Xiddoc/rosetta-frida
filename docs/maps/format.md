# Map format reference

A rosetta-frida **map** is a single strict-JSON file describing the real
→ obfuscated translation for one `(app, version_code)` pair. This page is
the field-by-field reference. For the authoring workflow, see
[Authoring](authoring.md); for the on-bundle embedding, see
[Marker block](marker-block.md).

!!! info "Schema ownership"

    The canonical, language-neutral map schema is owned by the separate
    [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo
    (`schema/rosetta-map.schema.json` — the source of truth for the
    `schema_version: 3` format). rosetta-frida is a **client** of that
    schema: its Zod validator (`src/validate/schema.ts`) tracks the
    canonical schema. This page documents the same format as consumed by
    the Frida client. `rosetta-xposed` (Kotlin) is the other client.

The canonical example lives at `maps/com.example.app/30405.json`
in the repo. It exercises every feature documented here at least
once — 15 classes covering AIDL stubs, callback proxies, value
objects, an enum, a synthetic Companion, an anonymous inner class.

## Top-level shape

```typescript
interface RosettaMap {
    schema_version: 3;
    app: string;
    version: string;
    version_code: number;
    captured_at?: string; // ISO YYYY-MM-DD
    signer_sha256?: string | string[]; // single hash OR match-any array
    generated_from?: { signatures_rev: string };
    status?: 'active' | 'superseded' | 'retracted';
    superseded_by?: number;
    client_hints?: {
        frida_min_version?: string;
        frida_max_version?: string;
    };
    sources?: MapSource[];
    classes: ClassMap;
}
```

### Required fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | `3` | The schema version. Must be `3`. Bumped on breaking schema changes; old maps will fail to load against newer libraries until in-tree migrators are added. (`3` removed `confidence`, tightened `captured_at` to an ISO date, let `signer_sha256` be an array, and added `generated_from` / `status` / `superseded_by`.) |
| `app` | string | Android package name (`com.example.app`). Cross-checked against the auto-detected app at session start. |
| `version` | string | App version *label* (`PackageInfo.versionName`, e.g. `3.4.5`). A human display label only — NOT authoritative for selection (labels can repeat across builds). Used as the fuzzy-match fallback key. |
| `version_code` | integer | **The authoritative app-identity key** — the full Android `longVersionCode` (`(versionCodeMajor << 32) | versionCode`), never masked. The runtime selects maps by this first (O(1), monotonic per build); the `version` label is only a fallback. Capped at Number.MAX_SAFE_INTEGER (2^53 − 1) so the Frida JS client can represent it exactly. |
| `classes` | object | Real-FQN → `ClassEntry`. The whole point of the file. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `captured_at` | ISO date (`YYYY-MM-DD`) | When the map was captured. Validated as a real calendar date — arbitrary text is rejected (schema 3, #39). Useful when reading old maps to know how stale they are. |
| `signer_sha256` | SHA-256 hex, or array of them | Authenticity guard — the SHA-256 of the APK *signing certificate* (not the APK bytes). Either a single bare-lowercase 64-hex digest **or a non-empty array** of them; a live signer matching **any** entry passes (schema 3, #38 — covers key-rotation lineages). Cheap to verify on-device via PackageManager; guards against loading a map for a repackaged/spoofed app. **Enforced at attach time:** when present, `rosetta.session(...)` reads the live app's signing certificate in-process and fails closed (`SignerMismatchError`) on a mismatch. Opt out with `enforceSigner: false`. See [API · Session](../api/session.md#signer-enforcement). |
| `generated_from` | object | Provenance pointer back to the signatures revision this map was generated from (schema 3, #36). When present, `signatures_rev` (a 7–40-char git commit hash) is required. |
| `status` | `'active' \| 'superseded' \| 'retracted'` | Lifecycle status (schema 3, #40). Absent ⇒ `active`. A `superseded` map still loads but `rosetta.session(...)` emits a `map-status` warning event; a `retracted` map is refused fail-closed (`MapRetractedError`). |
| `superseded_by` | integer | The `version_code` of the map that replaces this one. Only meaningful alongside `status: 'superseded'` (or as a hint on a `retracted` map). |
| `client_hints` | object | Per-client metadata (its own keys are strict). Frida reads `client_hints.frida_min_version` / `client_hints.frida_max_version` (semver) — the Frida runtime range this map is known to work with. Not enforced at runtime in V1; emitted as metadata. |
| `sources` | `MapSource[]` | Provenance per tool. See [Provenance](#provenance). |

## Provenance — `sources` { #provenance }

A real map for a non-trivial app comes from several tools. The format
tracks which entries came from where:

```json
"sources": [
    {
        "tool": "sigmatcher",
        "config": "signatures/example.json",
        "classes": 10
    },
    {
        "tool": "hand-authored",
        "classes": 5,
        "notes": "verified via Frida runtime trace on emulator"
    }
]
```

```typescript
interface MapSource {
    tool: string;
    config?: string;
    classes?: number;
    notes?: string;
}
```

Each class entry can carry a `source: <tool>` field that
cross-references one of these entries — see
[`ClassEntry.source`](#classentry-fields).

| Field | Description |
|---|---|
| `tool` | Free-form. Common values: `sigmatcher`, `hand-authored`, `rosetta-runtime-discovered` (V2+), `jadx`. |
| `config` | The config or config-path the tool was run with. |
| `classes` | Count of classes attributed to this source. |
| `notes` | Free-form notes about the capture session. |

## Classes — `ClassEntry`

A class entry is keyed by its real fully-qualified name:

```json
"classes": {
    "com.example.app.IRemoteService$Stub": {
        "obfuscated": "aaaa",
        "extends": "android.os.Binder",
        "kind": "aidl_stub",
        "dex": "classes6.dex",
        "aidl_descriptor": "com.example.app.IRemoteService",
        "anchors": ["com.example.app.IRemoteService", "Transaction failed"],
        "source": "sigmatcher",
        "methods": { /* ... */ },
        "fields": { /* ... */ }
    }
}
```

### `ClassEntry` fields { #classentry-fields }

```typescript
interface ClassEntry {
    obfuscated: string;
    extends?: string;
    kind?: ClassKind;
    dex?: string;
    aidl_descriptor?: string;
    anchors?: string[];
    methods?: MethodMap;
    fields?: FieldMap;
    source?: string;
}

type ClassKind =
    | 'class'
    | 'interface'
    | 'enum'
    | 'aidl_stub'
    | 'aidl_callback'
    | 'synthetic'
    | 'anonymous';
```

| Field | Description |
|---|---|
| `obfuscated` | The obfuscated short name (`aaaa`, `bbbb`). The whole point of the entry. |
| `extends` | Parent class. Either a real name (must also be a key in `classes`) or an obfuscated name (for parents like `java.lang.Object` or framework helpers we don't have a real-name mapping for). |
| `kind` | What kind of class this is. Drives V2+ runtime discovery — e.g. `synthetic` classes get skipped by adaptive strategies. |
| `dex` | DEX shard the class lives in (`classes6.dex`). Optional debugging metadata. |
| `aidl_descriptor` | The stable AIDL interface descriptor (`com.example.app.IRemoteService`). Cross-version anchor for `aidl_stub` and `aidl_callback` kinds. Checked at attach time by the health check. |
| `anchors` | Stable string literals contained in the class. Checked at attach time against `klass.$anchorStrings`. Used by V2+ discovery strategies. |
| `methods` | Methods keyed by real name. See [Methods](#methods). |
| `fields` | Fields keyed by real name. See [Fields](#fields). |
| `source` | Cross-reference into top-level `sources` — which tool contributed this entry. |

## Methods

Methods are keyed by real method name. The value is either a single
`MethodEntry` (the common case) or an array (when one real name has
multiple overloads).

### Single-overload form

```json
"methods": {
    "requestPrompt": {
        "obfuscated": "f",
        "signature": "(Landroid/os/Bundle;Lcccc;)V",
        "aidl_txn": 3
    },
    "isComplete": {
        "obfuscated": "e",
        "signature": "()Z"
    }
}
```

### Overload-array form

```json
"methods": {
    "requestTicket": [
        {
            "obfuscated": "c",
            "signature": "(Landroid/os/Bundle;Lbbbb;)V",
            "aidl_txn": 2
        },
        {
            "obfuscated": "d",
            "signature": "(Landroid/os/Bundle;Ljava/lang/String;Lbbbb;)V",
            "aidl_txn": 4
        }
    ]
}
```

### `MethodEntry` fields

```typescript
interface MethodEntry {
    obfuscated: string;
    signature: string;
    aidl_txn?: number;
    static?: boolean;
    synthetic?: boolean;
    is_constructor?: boolean;
}

type MethodMap = Record<string, MethodEntry | MethodEntry[]>;
```

| Field | Description |
|---|---|
| `obfuscated` | Obfuscated method name (`c`, `f`). Some methods keep their real names (`onTransact`, `values`, `valueOf`) — that's fine, just use the same string. |
| `signature` | JVM descriptor with obfuscated class refs in `L...;` positions. Example: `(Landroid/os/Bundle;Lbbbb;)V`. The resolver parses this to translate `.overload(...)` calls. |
| `aidl_txn` | AIDL transaction code, if this is a binder dispatch target. Stable per AIDL descriptor by aidl-compiler's assignment. |
| `static` | Whether the method is static. |
| `synthetic` | Whether the method is compiler-generated (e.g. bridge methods). |
| `is_constructor` | `true` for `<init>` entries — constructors. |

### Constructors

Constructors are written with the real name `<init>` and the obfuscated
name also `<init>`. Frida exposes them the same way:

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

## Fields

Fields are keyed by real field name:

```json
"fields": {
    "sessionId": {
        "obfuscated": "a",
        "type": "Ljava/lang/String;"
    },
    "MAX_SIZE": {
        "obfuscated": "b",
        "type": "I",
        "static": true
    }
}
```

```typescript
interface FieldEntry {
    obfuscated: string;
    type: string;
    static?: boolean;
}

type FieldMap = Record<string, FieldEntry>;
```

| Field | Description |
|---|---|
| `obfuscated` | Obfuscated field name. |
| `type` | JVM descriptor for the field type. Primitives: `I`, `J`, `Z`, `B`, `C`, `S`, `F`, `D`. Class refs: `L<obfClassName>;` — the on-disk type uses *obfuscated* class refs, just like method signatures. |
| `static` | Whether the field is static. Static fields are accessed via the class proxy (`Klass.STATIC_FIELD.value`); instance fields via [`rosetta.field(...)`](../api/tier-1.md#rosettafield) on an instance. |

## Cross-class type references

When a method signature mentions another mapped class
(`(Landroid/os/Bundle;Lbbbb;)V` — `bbbb` is
`com.example.app.IServiceCallback`), the Resolver builds a reverse
index at load time. This lets the proxy layer translate
`.overload('com.example.app.IServiceCallback', ...)` into
`.overload('bbbb', ...)` automatically.

The on-disk format always uses *obfuscated* class refs in signatures
and field types — they're what the underlying Frida runtime
ultimately needs.

## Multi-version registry

For a single bundle that ships maps for many versions:

```typescript
type RosettaMapRegistry = Record<string, RosettaMap>;
```

```json
{
    "3.4.5": {
        "schema_version": 3,
        "app": "com.example.app",
        "version": "3.4.5",
        "version_code": 30405,
        "classes": {}
    },
    "3.4.6": {
        "schema_version": 3,
        "app": "com.example.app",
        "version": "3.4.6",
        "version_code": 30406,
        "classes": {}
    }
}
```

The registry is keyed by `version` label for human readability, but
the session selects the right entry by the detected **`version_code`**
first (scanning the entries for a matching code), falling back to the
label only when no code is available or matches. With
`versionMatch: 'exact'`, a non-matching build throws; with `'fuzzy'`,
the closest label wins.

See [Multi-version bundle recipe](../recipes/multi-version-bundle.md)
for the full workflow.

## Loading maps — `loadMap`

```typescript
import { loadMap } from 'rosetta-frida';

const map = await loadMap('./maps/com.example.app/30405.json');
```

`loadMap` accepts:

- A `RosettaMap` (passed through the validator and returned).
- A strict-JSON source string (parsed, then validated). Comments and
  trailing commas are rejected.
- A filesystem path (read, parsed, validated).

The path-vs-source heuristic is cheap: if the first non-whitespace
character looks like JSON (`{`, `[`, `"`, digit, …) the string
is treated as source. Otherwise it's a path.

In the Frida runtime (where there is no filesystem), `loadMap` is
typically not needed — the map reaches your hook via
`import map from './x.json'` at compile time. `loadMap` shines on
the CLI side and in tests.

## Validation

Every map flows through a Zod schema. Authoring tools (the CLI,
`loadMap`, `yamlToMap`) all run the same validator, so format errors
surface uniformly:

```text
FAIL: maps/com.example.app/30405.json — invalid map
  at classes.com.example.app.IRemoteService$Stub.obfuscated: required
  at classes.com.example.app.Foo.methods.bar.signature: must match /\(.*\)[^()]+/
```

The Zod schema is exported from the package as `rosettaMapSchema`
for callers that want to validate ad-hoc objects:

```typescript
import { rosettaMapSchema, MapValidationError } from 'rosetta-frida';

const result = rosettaMapSchema.safeParse(maybeMap);
if (!result.success) {
    throw new MapValidationError(
        'failed validation',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
}
```

See [Errors — MapValidationError](../reference/errors.md#mapvalidationerror)
for the error shape.

## Validation limits (security bounds)

A map is untrusted input. To stop a hostile or corrupt map from driving
unbounded work in the resolver — or shadowing object internals via
crafted record keys — the validator enforces hard caps that mirror the
canonical JSON Schema in
[`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps)
(`schema/rosetta-map.schema.json`). A map that exceeds any cap fails
validation up front rather than at attach time.

| Bound                       | Limit                                            |
| --------------------------- | ------------------------------------------------ |
| `classes` entries           | 50 000                                           |
| `methods` per class         | 5 000                                            |
| `fields` per class          | 5 000                                            |
| method overloads (array)    | 200 (min 1)                                      |
| `anchors` per class         | 1 000                                            |
| `sources`                   | 100                                              |
| `version_code`              | 9 007 199 254 740 991 (Number.MAX_SAFE_INTEGER, 2^53 − 1 — the full longVersionCode) |
| obfuscated / short names    | 512 chars                                        |
| `extends`                   | 4 096 chars (free-form / possibly-FQN type name) |
| `signature` / field `type`  | 4 096 chars                                      |
| `app`                       | 256 chars                                        |
| `version`                   | 256 chars                                        |
| any other free-form string  | 4 096 chars                                      |

Two additional shape constraints:

- **`app`** must be a dotted package name
  (`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`).
- **`signer_sha256`** (when present) is either a single 64-lowercase-hex
  string (`^[0-9a-f]{64}$`) or a non-empty array of such strings (match-any).
  The map value is always bare lowercase hex — no colons/uppercase; the
  session layer normalises the *live app-presented* hash (strip `:`,
  lowercase) before comparison.
- **`generated_from.signatures_rev`** (when present) must be a 7–40-char
  lowercase-hex git commit hash (`^[0-9a-f]{7,40}$`).
- **`status`** (when present) is one of `active` / `superseded` /
  `retracted`; **`superseded_by`** is a non-negative integer `version_code`.

**Reserved keys.** The keys `__proto__`, `constructor`, and `prototype`
are rejected anywhere they appear in a `classes`, `methods`, or `fields`
object. (`JSON.parse` produces a genuine own `__proto__` key, so this is
checked against the raw input.) This blocks prototype-pollution /
bracket-index footguns in the resolver; the whole map is rejected rather
than silently sanitised.

## Schema evolution

`schema_version` is mandatory; missing-version maps fail to load.

New optional fields are additive: old maps continue to load against
newer libraries (the library just sees `undefined` for the new
fields).

Breaking changes bump `schema_version`. The current schema is `3`
(it removed `confidence`, tightened `captured_at` to an ISO date, let
`signer_sha256` be an array of hashes, and added the optional
`generated_from`, `status`, and `superseded_by` fields); `schema_version: 2`
(and `1`) maps fail to load and must be re-emitted at version `3`. Future
breaking changes will ship in-tree migrators (`3 → 4`, ...) so old
maps keep loading after migration.

!!! note "Bumping the schema version (maintainers)"

    The version lives in **one** place — `CURRENT_SCHEMA_VERSION` in
    `src/types/map.ts` — which drives the `RosettaMap.schema_version`
    type, the Zod gate, the adapter, and `rosetta init`. To bump it:

    1. Change `CURRENT_SCHEMA_VERSION`.
    2. Run `npm run schema-version:fix` to update the literals in the
       docs and the canonical sample map, then review the diff.
    3. Update any negative-test fixtures by hand (the suite deliberately
       carries invalid/old versions for rejection tests).

    `npm run schema-version:check` (part of `npm run verify` and CI)
    fails if a doc/sample literal drifts from the constant. Mark an
    intentional older literal inside a code block with a `schema-keep`
    comment to exempt it.
