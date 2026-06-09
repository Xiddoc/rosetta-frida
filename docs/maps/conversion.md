# Conversion — YAML → strict JSON

rosetta-frida's canonical on-disk format is **strict JSON** (no
comments, no trailing commas). YAML is supported as a comment-bearing
*authoring* input format via a converter, so contributors who prefer
YAML can still author maps without losing the runtime's strict schema
validation — `rosetta convert` renders YAML to the canonical JSON
artifact.

## Format choice

| Format | Role | Native bundler import | Comments | Type safety |
|---|---|---|---|---|
| **JSON** | The canonical on-disk artifact. | Yes (`.json`) — `frida-compile` resolves the import and inlines the value. | No (strict). | Validated at load. |
| **YAML** | Authoring input. | No — must convert via CLI. | Yes. | Validated post-conversion. |

Recommendation:

- **For maps you commit:** the canonical JSON artifact (optionally
  generated from a YAML authoring source via `rosetta convert`).
- **For authoring:** JSON for one-format simplicity, or YAML when there
  are many classes and you want comments / multi-line strings.

The canonical artifact is strict JSON because it's natively importable
by any JS bundler, machine-round-trippable, and trivially embeddable
as a JS literal in the marker block.

## JSON parsing

The artifact is strict JSON, so loading is just `JSON.parse` wrapped
with positioned error reporting — comments and trailing commas are
rejected as syntax errors. `parseJson` is the helper that does this
and throws [`JsonParseError`](../reference/errors.md#jsonparseerror)
with a line/column on failure.

```typescript
import { parseJson } from 'rosetta-frida';

const source = `
{
    "schema_version": 2,
    "app": "com.example.app",
    "version": "3.4.5",
    "version_code": 30405,
    "classes": {}
}
`;
const map = parseJson(source);
```

## YAML

YAML conversion uses the [`yaml`](https://eemeli.org/yaml/) package
(the eemeli/yaml one, MIT, zero-dep).

```yaml
# rosetta-frida map — com.example.app @ 3.4.5
schema_version: 2
app: com.example.app
version: "3.4.5"
version_code: 30405
classes:
  com.example.app.IRemoteService$Stub:
    obfuscated: aaaa
    kind: aidl_stub
    aidl_descriptor: com.example.app.IRemoteService
    methods:
      requestTicket:
        obfuscated: c
        signature: "(Landroid/os/Bundle;Lbbbb;)V"
        aidl_txn: 2
```

Convert to the canonical JSON artifact:

```sh
npx rosetta convert maps/com.example.app/3.4.5.yaml \
    -o maps/com.example.app/30405.json
```

Programmatically:

```typescript
import { yamlToMap, renderJson } from 'rosetta-frida';

const yamlSrc = await readFile('map.yaml', 'utf8');
const map = yamlToMap(yamlSrc);          // validated RosettaMap
const json = renderJson(map);            // canonical strict-JSON string
await writeFile('map.json', json, 'utf8');
```

`yamlToMap` runs the same Zod schema validator as
[`loadMap`](format.md#loading-maps-loadmap) — invalid maps surface
as [`MapValidationError`](../reference/errors.md#mapvalidationerror)
with a concrete list of issue paths.

### YAML gotchas

- **Quote your versions.** `3.4.5` is a valid YAML number-ish thing
  in some parsers. Quote `"3.4.5"` to be unambiguous.
- **Inline-string signatures.** Use double-quotes for JVM descriptors
  to avoid YAML's special characters interfering:
  `"(Landroid/os/Bundle;Lbbbb;)V"`.
- **Map keys that look numeric.** `3.4.5:` as a key in a YAML
  registry will be parsed as a float key. Quote: `"3.4.5":`.

## TypeScript modules — not supported

TS/JS inputs (`.ts`/`.js`/`.mjs`/`.cjs`) are not accepted by `rosetta
convert` / `validate`; a module path is refused with a clear error,
never imported. Maps are pure data — author them as JSON or YAML (both
validate against the same schema). If you keep a TS authoring source for
IDE type-checking, treat it as documentation and hand-port the data into
YAML or JSON. See the [changelog](../changelog.md) for the security
rationale behind dropping module ingestion.

## Renderer — `renderJson(map)`

The canonical strict-JSON writer. Takes an in-memory `RosettaMap`, returns
a string with:

- 4-space indent.
- Top-level keys in insertion order (`schema_version` first, then
  `app`, `version`, `version_code`, `captured_at`, ..., `classes`
  last).
- Stable class ordering (insertion order preserved).
- No comments — the artifact is pure strict JSON. (`rosetta init`
  likewise emits a plain-JSON skeleton; field documentation lives in
  [Map format](format.md), not inline.)

```typescript
import { renderJson } from 'rosetta-frida';

const json = renderJson(map);
```

## `convertToJson` — one-stop entry point

The CLI's `convert` command uses `convertToJson` internally — a
single async function that takes a source string and a format
discriminator, runs the right converter, and returns the rendered strict
JSON:

```typescript
import { convertToJson } from 'rosetta-frida';

const yamlSrc = await readFile('map.yaml', 'utf8');
const json = await convertToJson(yamlSrc, 'yaml');
```

YAML is the only authoring format `convertToJson` accepts. A TS/JS
module *path* passed here is refused, never imported.

## Round-trip fidelity

`yamlToMap` → `renderJson` is **not** byte-stable across the two
formats — comments don't carry over, key ordering normalizes, and
whitespace formatting is canonicalized. The *data* is
identical, but the source is canonicalized.

If you want comments, keep them in the YAML authoring source and
re-render; do not hand-edit the output.
