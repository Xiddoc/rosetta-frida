# `rosetta convert`

Convert a YAML map to canonical JSON.

> **Removed (security):** TS/JS-module inputs (`.ts`/`.js`/`.mjs`/`.cjs`)
> are no longer supported. They used to be loaded via dynamic `import()`,
> which executed arbitrary contributor-supplied code at author/build time
> *before* validation — a build-time RCE. Maps are pure data: author them
> as **JSON or YAML**. A module path is now refused with a clear error,
> never imported.

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
| `.ts`, `.js`, `.mjs`, `.cjs` | **Refused** — TS/JS map modules are no longer supported (build-time RCE). Author as JSON or YAML. Never imported. |
| `.json` | **Rejected** — input is already canonical; nothing to convert. Use `rosetta validate` instead. |

The output path (`-o`/`--output`) is contained to the project tree
(the current working directory): a traversal (`../…`) or absolute path
that escapes the tree is refused, as is any path containing a NUL byte.

## Examples

### YAML → JSON

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.yaml \
    -o maps/com.example.app/30405.json
wrote maps/com.example.app/30405.json
```

### TS/JS module → refused

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.ts \
    -o maps/com.example.app/30405.json
error: TS/JS map modules are no longer supported; author maps as JSON or YAML (path: maps/com.example.app/3.4.5.ts)
```

### Output escaping the project tree → refused

```sh
$ npx rosetta convert maps/in.yaml -o ../../etc/cron.d/x.json
error: refusing to write outside the project tree: '../../etc/cron.d/x.json' resolves to '/etc/cron.d/x.json' (must stay within '/home/you/project')
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
$ npx rosetta convert maps/com.example.app/30405.json -o maps/out.json
error: input is already in canonical format (.json); nothing to convert
```

```sh
$ npx rosetta convert maps/com.example.app/3.4.5.toml -o maps/out.json
error: unsupported input format: .toml (path: maps/com.example.app/3.4.5.toml)
```

## What the rendered JSON looks like

`renderJson` writes canonical 4-space-indented JSON. Top-level keys
are in a stable order (`schema_version`, then `app`, `version`,
`version_code`, `captured_at`, `signer_sha256`, `client_hints`,
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
import { yamlToMap, renderJson } from 'rosetta-frida';
import { readFile, writeFile } from 'node:fs/promises';

// YAML
const yamlSrc = await readFile('map.yaml', 'utf8');
const yamlMap = yamlToMap(yamlSrc);
await writeFile('map.json', renderJson(yamlMap), 'utf8');
```

## Round-trip note

YAML → JSON conversion is one-way. Comments don't carry over;
key ordering normalizes; whitespace is canonicalized. The
*data* is identical, but the source is canonicalized.

If you maintain authoritative annotated YAML sources, treat
the JSON as a build artifact and regenerate it on demand.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Conversion + validation succeeded; output written. |
| `1` | Bad arguments, validation failure, IO error, or unsupported input format. |

## When to use which input format

See [Conversion](../maps/conversion.md) for the rationale on YAML vs
JSON. Short version:

- **JSON** for committed maps. One format to support; native bundler
  import.
- **YAML** for authoring (comments, multi-line strings). Convert on
  commit.

TS/JS modules are no longer an authoring format (build-time RCE).
