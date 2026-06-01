# Conversion — YAML / TS module → strict JSON

rosetta-frida's canonical on-disk format is **strict JSON** (no
comments, no trailing commas). Two comment-bearing *authoring* input
formats are supported via converters so contributors who prefer YAML
or TypeScript can still author maps without losing the runtime's
strict schema validation — `rosetta convert` renders them to the
canonical JSON artifact.

## Format choice

| Format | Role | Native bundler import | Comments | Type safety |
|---|---|---|---|---|
| **JSON** | The canonical on-disk artifact. | Yes (`.json`) — `frida-compile` resolves the import and inlines the value. | No (strict). | Validated at load. |
| **TypeScript module** | Authoring input; full IDE help. | Yes (`.ts`) — `frida-compile` compiles it. | Yes. | Yes (compile time), then validated again. |
| **YAML** | Authoring input. | No — must convert via CLI. | Yes. | Validated post-conversion. |

Recommendation:

- **For maps you commit:** the canonical JSON artifact (optionally
  generated from a YAML / TS authoring source via `rosetta convert`).
- **For authoring:** whichever input the author prefers. TS gives IDE
  feedback; YAML reads cleaner when there are many classes.

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
    -o maps/com.example.app/3.4.5.json
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

## TypeScript modules

Power users can author maps as TS modules with a default-exported (or
named `map`-exported) `RosettaMap`. The conversion runs the module
through dynamic `import()` and pulls the value out:

```typescript
// maps/com.example.app/3.4.5.ts
import type { RosettaMap } from 'rosetta-frida';

const map: RosettaMap = {
    schema_version: 2,
    app: 'com.example.app',
    version: '3.4.5',
    version_code: 30405,
    classes: {
        'com.example.app.IRemoteService$Stub': {
            obfuscated: 'aaaa',
            kind: 'aidl_stub',
            aidl_descriptor: 'com.example.app.IRemoteService',
            methods: {
                requestTicket: {
                    obfuscated: 'c',
                    signature: '(Landroid/os/Bundle;Lbbbb;)V',
                    aidl_txn: 2,
                },
            },
        },
    },
};

export default map;
```

Convert:

```sh
npx rosetta convert maps/com.example.app/3.4.5.ts \
    -o maps/com.example.app/3.4.5.json
```

Programmatically:

```typescript
import { tsModuleToMap, renderJson } from 'rosetta-frida';

const map = await tsModuleToMap('/abs/path/to/map.ts');
const json = renderJson(map);
```

The function looks for a `default` export first, then a named `map`
export. Either works.

### TS module benefits

- **Compile-time type checking.** Typos in field names, wrong types
  on optional fields, missing required fields all surface at
  `tsc`-time.
- **Computed entries.** You can build maps with loops, helpers, or
  programmatic data sources — useful when the map is regenerated
  from another tool's output.
- **IDE autocomplete.** `RosettaMap`'s shape drives autocomplete in
  any TS-aware editor.

### TS module gotchas

- The path passed to `tsModuleToMap` must be resolvable by Node's
  dynamic `import()`. For relative paths, the CLI resolves them
  against `cwd` first.
- Don't run side effects at import time. The converter calls into the
  module exactly once, and any side effects fire on every conversion.

## Renderer — `renderJson(map)`

The canonical strict-JSON writer. Takes an in-memory `RosettaMap`, returns
a string with:

- 4-space indent.
- Sorted top-level keys (`schema_version` first, then `app`,
  `version`, `captured_at`, ..., `classes` last).
- Stable class ordering (insertion order preserved).
- No header comments — those are an authoring concern, not a
  serialization concern.

```typescript
import { renderJson } from 'rosetta-frida';

const json = renderJson(map);
```

For pretty-printing with header comments (e.g. the `rosetta init`
output), build the comment string yourself and concatenate. The
[init command implementation](https://github.com/rosetta-frida/rosetta-frida/blob/master/cli/commands/init.ts)
is a worked example.

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

The TS-module path is not supported through `convertToJson` (TS
needs a file path, not a string); call `tsModuleToMap` +
`renderJson` directly for those.

## Round-trip fidelity

`yamlToMap` → `renderJson` is **not** byte-stable across the two
formats — comments don't carry over, key ordering normalizes, and
whitespace formatting is canonicalized. The *data* is
identical, but the source is canonicalized.

If you want comments, keep them in the YAML/TS authoring source and re-render; do not hand-edit the output —
or keep a separate "annotated" source (YAML or TS) that the CLI
re-renders on demand.
