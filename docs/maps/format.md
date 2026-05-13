# Map format reference

A rosetta-frida **map** is a single JSONC file describing the real
→ obfuscated translation for one `(app, version)` pair. This page is
the field-by-field reference. For the authoring workflow, see
[Authoring](authoring.md); for the on-bundle embedding, see
[Marker block](marker-block.md).

The canonical example lives at `maps/com.example.app/3.4.5.jsonc`
in the repo. It exercises every feature documented here at least
once — 15 classes covering AIDL stubs, callback proxies, value
objects, an enum, a synthetic Companion, an anonymous inner class.

## Top-level shape

```typescript
interface RosettaMap {
    schema_version: 1;
    app: string;
    version: string;
    captured_at?: string;
    apk_sha256?: string;
    frida_min_version?: string;
    frida_max_version?: string;
    sources?: MapSource[];
    classes: ClassMap;
}
```

### Required fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | `1` | The schema version. Must be `1`. Bumped on breaking schema changes; old maps will fail to load against newer libraries until in-tree migrators are added. |
| `app` | string | Android package name (`com.example.app`). Cross-checked against the auto-detected app at session start. |
| `version` | string | App version (`3.4.5`). Cross-checked against the auto-detected version. |
| `classes` | object | Real-FQN → `ClassEntry`. The whole point of the file. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `captured_at` | ISO date string | When the map was captured. Useful when reading old maps to know how stale they are. |
| `apk_sha256` | SHA-256 hex | Integrity evidence — the SHA-256 of the APK this map was derived from. Not enforced at runtime in V1; reserved for V2+ trust workflows. |
| `frida_min_version`, `frida_max_version` | semver | The Frida runtime range this map is known to work with. Not enforced at runtime in V1; emitted as metadata. |
| `sources` | `MapSource[]` | Provenance per tool. See [Provenance](#provenance). |

## Provenance — `sources` { #provenance }

A real map for a non-trivial app comes from several tools. The format
tracks which entries came from where:

```jsonc
"sources": [
    {
        "tool": "sigmatcher",
        "config": "signatures/example.json",
        "classes": 10,
        "confidence": "high"
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
    confidence?: 'high' | 'medium' | 'low';
}
```

Each class entry can carry a `source: <tool>` field that
cross-references one of these entries — see
[`ClassEntry.source`](#classentry-fields).

| Field | Description |
|---|---|
| `tool` | Free-form. Common values: `sigmatcher`, `hand-authored`, `rosetta-frida-runtime-discovered` (V2+), `jadx`. |
| `config` | The config or config-path the tool was run with. |
| `classes` | Count of classes attributed to this source. |
| `notes` | Free-form notes about the capture session. |
| `confidence` | Default confidence for entries from this source. Per-entry `confidence` overrides it. |

## Classes — `ClassEntry`

A class entry is keyed by its real fully-qualified name:

```jsonc
"classes": {
    "com.example.app.IRemoteService$Stub": {
        "obfuscated": "aaaa",
        "extends": "android.os.Binder",
        "kind": "aidl_stub",
        "dex": "classes6.dex",
        "aidl_descriptor": "com.example.app.IRemoteService",
        "anchors": ["com.example.app.IRemoteService", "Transaction failed"],
        "source": "sigmatcher",
        "confidence": "high",
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
    confidence?: 'high' | 'medium' | 'low';
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
| `confidence` | Per-entry override of the source's default confidence. |

## Methods

Methods are keyed by real method name. The value is either a single
`MethodEntry` (the common case) or an array (when one real name has
multiple overloads).

### Single-overload form

```jsonc
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

```jsonc
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

```jsonc
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

```jsonc
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

```jsonc
{
    "3.4.5": {
        "schema_version": 1,
        "app": "com.example.app",
        "version": "3.4.5",
        "classes": { /* ... */ }
    },
    "3.4.6": {
        "schema_version": 1,
        "app": "com.example.app",
        "version": "3.4.6",
        "classes": { /* ... */ }
    }
}
```

The session picks the right entry by the detected version. With
`versionMatch: 'exact'`, a missing version throws; with `'fuzzy'`,
the closest version wins.

See [Multi-version bundle recipe](../recipes/multi-version-bundle.md)
for the full workflow.

## Loading maps — `loadMap`

```typescript
import { loadMap } from 'rosetta-frida';

const map = await loadMap('./maps/com.example.app/3.4.5.jsonc');
```

`loadMap` accepts:

- A `RosettaMap` (passed through the validator and returned).
- A JSONC source string (parsed, then validated).
- A filesystem path (read, parsed, validated).

The path-vs-source heuristic is cheap: if the first non-whitespace
character looks like JSON (`{`, `[`, `"`, digit, `/`, …) the string
is treated as source. Otherwise it's a path.

In the Frida runtime (where there is no filesystem), `loadMap` is
typically not needed — the map reaches your hook via
`import map from './x.json'` at compile time. `loadMap` shines on
the CLI side and in tests.

## Validation

Every map flows through a Zod schema. Authoring tools (the CLI,
`loadMap`, `yamlToMap`, `tsModuleToMap`) all run the same validator,
so format errors surface uniformly:

```text
FAIL: maps/com.example.app/3.4.5.jsonc — invalid map
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

## Schema evolution

`schema_version` is mandatory; missing-version maps fail to load.

New optional fields are additive: old maps continue to load against
newer libraries (the library just sees `undefined` for the new
fields).

Breaking changes will bump `schema_version` to `2`. The library will
ship in-tree migrators (`1 → 2`, ...) at that point so old maps keep
loading after migration. V1 ships only `schema_version: 1`.
