# `rosetta convert`

Convert a YAML or TypeScript-module map to canonical JSON.

## Synopsis

```sh
rosetta convert <in> -o <out> [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<in>` | Yes | Path to the input map. Format detected by extension. |
| `-o`, `--output <path>` | Yes | Output JSON path. |
| `-f`, `--force` | No | Overwrite an existing output file. |

## Recognized inputs

| Extension | Behavior |
|---|---|
| `.yaml`, `.yml` | Read, parse YAML, validate, render to JSON. |
| `.ts`, `.js`, `.mjs`, `.cjs` | Dynamically `import()`; default or named `map` export is validated and rendered. |
| `.json`, `.json` | **Rejected** — input is already canonical; nothing to convert. Use `rosetta validate` instead. |

## Examples

### YAML → JSON

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.yaml \
    -o maps/com.example.app/3.4.5.json
wrote maps/com.example.app/3.4.5.json
```

### TS module → JSON

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.ts \
    -o maps/com.example.app/3.4.5.json
wrote maps/com.example.app/3.4.5.json
```

### Overwrite

```sh
$ npx rosetta convert maps/in.yaml -o maps/out.json
error: refusing to overwrite existing file: maps/out.json (pass --force to overwrite)

$ npx rosetta convert maps/in.yaml -o maps/out.json --force
wrote maps/out.json
```

### Wrong input

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.json -o maps/out.json
error: input is already in canonical format (.json); nothing to convert
```

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.toml -o maps/out.json
error: unsupported input format: .toml (path: maps/com.example.app/3.4.5.toml)
```

## What the rendered JSON looks like

`renderJson` writes canonical 4-space-indented JSON. Top-level keys
are in a stable order (`schema_version`, then `app`, `version`,
`version_code`, `captured_at`, `signer_sha256`, `frida_min_version`,
`frida_max_version`,
`sources`, `classes`). Class ordering follows the input's insertion
order.

The output is plain strict JSON — no comments. If you want
comments in your canonical map, hand-edit the result.

## Validation runs first

Every conversion path validates the parsed map against the Zod
schema before writing the output. Invalid inputs surface as
[`MapValidationError`](../reference/errors.md#mapvalidationerror):

```text
$ npx rosetta convert maps/broken.yaml -o maps/out.json
error: invalid map
  at classes.com.example.app.Foo.obfuscated: required
```

This means converting and validating are not separate steps — a
successful `convert` implies a passing `validate`.

## Programmatic equivalent

```typescript
import { yamlToMap, tsModuleToMap, renderJson } from 'rosetta-frida';
import { readFile, writeFile } from 'node:fs/promises';

// YAML
const yamlSrc = await readFile('map.yaml', 'utf8');
const yamlMap = yamlToMap(yamlSrc);
await writeFile('map.json', renderJson(yamlMap), 'utf8');

// TS module
const tsMap = await tsModuleToMap('/abs/path/to/map.ts');
await writeFile('map.json', renderJson(tsMap), 'utf8');
```

## Round-trip note

YAML / TS → JSON conversion is one-way. Comments don't carry over;
key ordering normalizes; whitespace is canonicalized. The
*data* is identical, but the source is canonicalized.

If you maintain authoritative annotated YAML or TS sources, treat
the JSON as a build artifact and regenerate it on demand.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Conversion + validation succeeded; output written. |
| `1` | Bad arguments, validation failure, IO error, or unsupported input format. |

## When to use which input format

See [Conversion](../maps/conversion.md) for the rationale on YAML vs
TS vs JSON. Short version:

- **JSON** for committed maps. One format to support; native bundler
  import.
- **TS modules** for authoring with full type-checked IDE help.
- **YAML** for contributors who prefer it. Convert on commit.
