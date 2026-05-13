# `rosetta validate`

Load a map, run the schema + sanity check, print pass/fail. Format
auto-detected from the file extension.

## Synopsis

```sh
rosetta validate <map>
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<map>` | Yes | Path to a map file. The format is detected from the extension. |

Supported extensions:

| Extension | Format |
|---|---|
| `.json`, `.jsonc` | JSONC (default). JSONC comment-stripper runs first. |
| `.yaml`, `.yml` | YAML — converted in-memory to a map, then validated. |
| `.ts`, `.js`, `.mjs`, `.cjs` | TypeScript / JavaScript module — dynamically imported; default or named `map` export is validated. |

## Behavior

Loads the map via the appropriate path, runs the full [Zod
schema](../maps/format.md#validation) check, then prints either:

**Pass:**

```text
OK: maps/com.example.app/3.4.5.jsonc — com.example.app@3.4.5, 15 class(es), schema_version=1
```

Exit code 0.

**Fail:**

```text
FAIL: maps/com.example.app/3.4.5.jsonc — invalid map
  at classes.com.example.app.IRemoteService$Stub.obfuscated: required
  at classes.com.example.app.Foo.methods.bar.signature: must match /\(.*\)[^()]+/
```

Exit code 1.

## Examples

### JSONC

```sh
$ npx rosetta validate maps/com.example.app/3.4.5.jsonc
OK: maps/com.example.app/3.4.5.jsonc — com.example.app@3.4.5, 15 class(es), schema_version=1
```

### YAML

```sh
$ npx rosetta validate maps/com.example.app/3.4.5.yaml
OK: maps/com.example.app/3.4.5.yaml — com.example.app@3.4.5, 15 class(es), schema_version=1
```

### TS module

```sh
$ npx rosetta validate maps/com.example.app/3.4.5.ts
OK: maps/com.example.app/3.4.5.ts — com.example.app@3.4.5, 15 class(es), schema_version=1
```

### Invalid map

```sh
$ npx rosetta validate maps/example/broken.json
FAIL: maps/example/broken.json — invalid map
  at schema_version: must be 1
  at classes.com.example.app.Foo.methods: must be an object
```

## What validation checks

1. **Top-level fields.** `schema_version === 1`; `app` and `version`
   are strings; `classes` is an object.
2. **Class entries.** Every entry has `obfuscated: string`. Optional
   fields (`extends`, `kind`, `dex`, `aidl_descriptor`, `anchors`,
   `source`, `confidence`, `methods`, `fields`) match their declared
   types when present.
3. **Method entries.** `obfuscated` and `signature` required.
   Multi-overload arrays must be non-empty and have unique
   signatures within one real-name key.
4. **Field entries.** `obfuscated` and `type` required.
5. **Source provenance.** `sources[].tool` required. `confidence`
   if present must be one of `'high' | 'medium' | 'low'`.
6. **Signatures look like JVM descriptors.** `(...args...)return`
   shape with valid character classes.

Validation does **not** check the map matches a running app — that's
the [attach-time health check](../api/session.md#attach-time-health-check)
inside the Frida runtime. `rosetta validate` is purely a static
shape check.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Map is valid. |
| `1` | Schema validation failed, file is missing or unreadable, or extension is not supported. |

## CI integration

Validate every map on every PR:

```yaml
# .github/workflows/maps.yml
- name: Validate every map
  run: |
    fail=0
    for m in maps/**/*.json maps/**/*.yaml maps/**/*.yml; do
      [ -e "$m" ] || continue
      npx rosetta validate "$m" || fail=1
    done
    exit $fail
```

If you ship maps in many formats, validate them all — the schema
checks are identical post-conversion.

## Programmatic equivalent

```typescript
import { loadMap, MapValidationError } from 'rosetta-frida';

try {
    const map = await loadMap('maps/com.example.app/3.4.5.jsonc');
    console.log(`${map.app}@${map.version}, ${Object.keys(map.classes).length} classes`);
} catch (e) {
    if (e instanceof MapValidationError) {
        for (const issue of e.issues) {
            console.error(`  at ${issue.path}: ${issue.message}`);
        }
    }
    process.exit(1);
}
```

For YAML, use `yamlToMap`; for TS modules, use `tsModuleToMap`. All
three end up running the same validator under the hood.
