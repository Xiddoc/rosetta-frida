# Conversion — YAML / TS module / JSONC interchange

rosetta-frida's canonical on-disk format is **JSONC** (JSON with
Comments). Two additional input formats are supported via converters
so contributors who prefer YAML or TypeScript can still author
maps without losing the runtime's strict schema validation.

## Format choice

| Format | Authoring strength | Native bundler import | Comments | Type safety |
|---|---|---|---|---|
| **JSONC** | The canonical format. | Yes (`.json`/`.jsonc`) — `frida-compile` resolves the import and inlines the value. | Yes, in source. Stripped before `JSON.parse`. | Validated at load. |
| **TypeScript module** | Power users; full IDE help. | Yes (`.ts`) — `frida-compile` compiles it. | Yes. | Yes (compile time), then validated again. |
| **YAML** | Contributors comfortable with YAML. | No — must convert via CLI. | Yes. | Validated post-conversion. |

Recommendation:

- **For maps you commit:** JSONC. One format to support in CI; lowest
  friction for contributors.
- **For private / experimental maps:** whichever the author prefers.
  TS gives IDE feedback; YAML reads cleaner when there are many
  classes.

The canonical format is JSONC because it's natively importable by
any JS bundler, machine-round-trippable, and trivially embeddable
as a JS literal in the marker block.

## JSONC parsing

JSONC source has comments; `JSON.parse` rejects them. rosetta-frida
ships a small in-tree comment stripper rather than pulling in an
external JSONC parser:

- Handles C-style line comments (`//` to end-of-line).
- Handles C-style block comments (`/* ... */`).
- Respects string literals — comment-style sequences inside `"..."`
  are left intact, with backslash escapes honored.
- Strips trailing commas in arrays and objects (`[1, 2, 3,]` →
  `[1, 2, 3]`).

The stripper is exported as `stripCommentsAndTrailingCommas` for
callers that want to use it directly. `parseJsonc` is the higher-
level helper that strips + `JSON.parse`s and throws
[`JsoncParseError`](../reference/errors.md#jsoncparseerror) with a
line/column on failure.

```typescript
import { parseJsonc } from 'rosetta-frida';

const source = `
// the example map
{
    "schema_version": 1,
    /* trailing comma is fine in JSONC */
    "app": "com.example.app",
    "version": "3.4.5",
    "classes": {},
}
`;
const map = parseJsonc(source);
```

## YAML

YAML conversion uses the [`yaml`](https://eemeli.org/yaml/) package
(the eemeli/yaml one, MIT, zero-dep).

```yaml
# rosetta-frida map — com.example.app @ 3.4.5
schema_version: 1
app: com.example.app
version: "3.4.5"
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

Convert to canonical JSONC:

```sh
npx rosetta convert maps/com.example.app/3.4.5.yaml \
    -o maps/com.example.app/3.4.5.json
```

Programmatically:

```typescript
import { yamlToMap, renderJsonc } from 'rosetta-frida';

const yamlSrc = await readFile('map.yaml', 'utf8');
const map = yamlToMap(yamlSrc);          // validated RosettaMap
const jsonc = renderJsonc(map);           // canonical JSONC string
await writeFile('map.json', jsonc, 'utf8');
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
    schema_version: 1,
    app: 'com.example.app',
    version: '3.4.5',
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
import { tsModuleToMap, renderJsonc } from 'rosetta-frida';

const map = await tsModuleToMap('/abs/path/to/map.ts');
const jsonc = renderJsonc(map);
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

## Renderer — `renderJsonc(map)`

The canonical JSONC writer. Takes an in-memory `RosettaMap`, returns
a string with:

- 4-space indent.
- Sorted top-level keys (`schema_version` first, then `app`,
  `version`, `captured_at`, ..., `classes` last).
- Stable class ordering (insertion order preserved).
- No header comments — those are an authoring concern, not a
  serialization concern.

```typescript
import { renderJsonc } from 'rosetta-frida';

const jsonc = renderJsonc(map);
```

For pretty-printing with header comments (e.g. the `rosetta init`
output), build the comment string yourself and concatenate. The
[init command implementation](https://github.com/rosetta-frida/rosetta-frida/blob/master/cli/commands/init.ts)
is a worked example.

## `convertToJsonc` — one-stop entry point

The CLI's `convert` command uses `convertToJsonc` internally — a
single async function that takes a source string and a format
discriminator, runs the right converter, and returns the rendered
JSONC:

```typescript
import { convertToJsonc } from 'rosetta-frida';

const yamlSrc = await readFile('map.yaml', 'utf8');
const jsonc = await convertToJsonc(yamlSrc, 'yaml');
```

The TS-module path is not supported through `convertToJsonc` (TS
needs a file path, not a string); call `tsModuleToMap` +
`renderJsonc` directly for those.

## Round-trip fidelity

`yamlToMap` → `renderJsonc` is **not** byte-stable across the two
formats — comments don't carry over, key ordering normalizes, and
whitespace formatting follows JSONC convention. The *data* is
identical, but the source is canonicalized.

If you want comments in the rendered JSONC, hand-edit the output —
or keep a separate "annotated" source (YAML or TS) that the CLI
re-renders on demand.
