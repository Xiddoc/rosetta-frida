# `rosetta init`

Scaffold a JSONC skeleton for a new `(app, version)` pair.

## Synopsis

```sh
rosetta init <app> <version> [-o <path>] [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<app>` | Yes | Android package name, e.g. `com.example.app`. Becomes the top-level `"app"` field in the scaffolded map. |
| `<version>` | Yes | App version, e.g. `3.4.5`. Becomes the `"version"` field. |
| `-o`, `--output <path>` | No | Output path. Defaults to `maps/<app>/<version>.json`. |
| `-f`, `--force` | No | Overwrite an existing file at the output path. |

## What it writes

A JSONC skeleton with:

- Header comments documenting each required field.
- All required top-level metadata filled in.
- An empty `classes: {}`.
- A single example class entry, commented out — so a new user reads
  the comment, uncomments, and edits inline.

```jsonc
// rosetta-frida map — skeleton scaffold.
//
// Edit this file to fill in real-name → obfuscated-name mappings for
// each class, method, and field you want to hook in
// com.example.app@3.4.5.
//
// Top-level fields:
//   schema_version: integer — must be 1 (current schema).
//   app:            string  — Android package name.
//   version:        string  — app version.
//   captured_at:    string  — ISO date this map was captured.
//   sources:        array   — provenance (which tool produced which entries).
//   classes:        object  — keyed by real fully-qualified class name.
//
// See maps/com.example.app/3.4.5.json for a fully-worked example
// demonstrating every supported field.
{
    "schema_version": 1,
    "app": "com.example.app",
    "version": "3.4.5",
    "captured_at": "",
    "sources": [
        {
            "tool": "hand-authored",
            "classes": 0,
            "notes": "initial scaffold"
        }
    ],
    "classes": {
        // Example class entry (uncomment + edit to use):
        //
        // "com.example.app.IRemoteService$Stub": {
        //     "obfuscated": "aaaa",
        //     "kind": "aidl_stub",
        //     "aidl_descriptor": "com.example.app.IRemoteService",
        //     "methods": { ... },
        //     "fields": { ... }
        // }
    }
}
```

## Examples

### Default path

```sh
$ npx rosetta init com.example.app 3.4.5
wrote maps/com.example.app/3.4.5.json
```

### Custom path

```sh
$ npx rosetta init com.example.app 3.4.5 -o vendor/maps/example.json
wrote vendor/maps/example.json
```

### Refuses to overwrite by default

```sh
$ npx rosetta init com.example.app 3.4.5
error: refusing to overwrite existing file: maps/com.example.app/3.4.5.json (pass --force to overwrite)
```

```sh
$ npx rosetta init com.example.app 3.4.5 --force
wrote maps/com.example.app/3.4.5.json
```

## Behavior notes

- The output directory is created recursively if missing
  (`mkdir -p`).
- The scaffold's `captured_at` field is left empty — fill it with an
  ISO date when you commit the map.
- The scaffold's `sources` array has one `hand-authored` entry with
  `classes: 0`. Update it when you add real entries; the field is
  free-form provenance.
- No flag enables auto-detect of the running version from a
  connected device. `init` is purely a filesystem scaffold; for
  runtime detection see [`rosetta.session({ })`'s in-process
  auto-detect](../api/session.md#app-version).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Skeleton written. |
| `1` | Bad arguments, target exists and `--force` not passed, or filesystem error. |

## What to do next

After running `init`:

1. Open the skeleton in your editor.
2. Fill in entries from jadx, sigmatcher, or hand-authored
   discoveries.
3. Run [`rosetta validate`](validate.md) to check the shape.
4. Compile a hook and run it on a device to verify the [health
   check](../api/session.md#attach-time-health-check) passes.
5. Commit.

See [Authoring maps](../maps/authoring.md) for the full workflow.
