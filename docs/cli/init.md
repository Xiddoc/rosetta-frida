# `rosetta init`

Scaffold a strict-JSON skeleton for a new `(app, version)` pair.

## Synopsis

```sh
rosetta init <app> <version> --version-code <code> [-o <path>] [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<app>` | Yes | Android package name, e.g. `com.example.app`. Becomes the top-level `"app"` field in the scaffolded map. |
| `<version>` | Yes | App versionName, e.g. `3.4.5`. Becomes the `"version"` field (a human label). |
| `--version-code <code>` | **Yes** | The Android `PackageInfo.versionCode` (a positive integer). It is the authoritative O(1) selection key and the **default output filename** (`<version_code>.json`), so it is required — without it the filename can't obey the `basename == version_code` invariant. |
| `-o`, `--output <path>` | No | Output path. Defaults to `maps/<app>/<version_code>.json`. |
| `-f`, `--force` | No | Overwrite an existing file at the output path. |

## What it writes

A plain strict-JSON skeleton (no comments — field documentation lives
in [Maps — format](../maps/format.md)) with:

- All required top-level metadata filled in, including the mandatory
  non-zero `version_code` you supplied via `--version-code`.
- A single worked example class entry under `classes` so you see the
  shape and edit it in place.

```json
{
    "schema_version": 4,
    "app": "com.example.app",
    "version": "3.4.5",
    "version_code": 30405,
    "captured_at": "",
    "sources": [
        {
            "tool": "hand-authored",
            "classes": 1,
            "notes": "initial scaffold"
        }
    ],
    "classes": {
        "com.example.app.IRemoteService$Stub": {
            "obfuscated": "aaaa",
            "kind": "class",
            "methods": {
                "requestTicket": {
                    "obfuscated": "c",
                    "signature": "(Landroid/os/Bundle;Lbbbb;)V"
                }
            },
            "fields": {
                "sessionId": {
                    "obfuscated": "a",
                    "type": "Ljava/lang/String;"
                }
            }
        }
    }
}
```

## Examples

### Default path

```sh
$ npx rosetta init com.example.app 3.4.5 --version-code 30405
wrote maps/com.example.app/30405.json
```

### Custom path

```sh
$ npx rosetta init com.example.app 3.4.5 --version-code 30405 -o vendor/maps/example.json
wrote vendor/maps/example.json
```

### Refuses to overwrite by default

```sh
$ npx rosetta init com.example.app 3.4.5 --version-code 30405
error: refusing to overwrite existing file: maps/com.example.app/30405.json (pass --force to overwrite)
```

```sh
$ npx rosetta init com.example.app 3.4.5 --version-code 30405 --force
wrote maps/com.example.app/30405.json
```

### Missing `--version-code` fails fast

```sh
$ npx rosetta init com.example.app 3.4.5
rosetta init: init requires --version-code <n> (a positive integer Android versionCode); without it the output filename cannot obey the filename == version_code invariant
```

## Behavior notes

- The output directory is created recursively if missing
  (`mkdir -p`).
- The scaffold's `captured_at` field is left empty — fill it with an
  ISO date when you commit the map.
- `--version-code` is **required** and must be a positive integer; it
  is written verbatim into the skeleton's `version_code` and used as
  the default filename. It is the authoritative key the runtime selects
  maps by, so there is no `0` placeholder to remember to replace.
- The scaffold's `sources` array has one `hand-authored` entry with
  `classes: 1` (the worked example). Update it as you add real entries; the field is
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
