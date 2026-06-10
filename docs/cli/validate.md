# `rosetta validate`

Load a map, run the schema + sanity check, print pass/fail. Format
auto-detected from the file extension. With `--deep` it additionally runs the
**semantic** consistency checks (the former `verify` verb, folded in here).

## Synopsis

```sh
rosetta validate <map> [--deep] [--json]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<map>` | Yes | Path to a map file. The format is detected from the extension. |
| `--deep`, `--semantic` | No | Additionally run the deep semantic checks (see [Deep semantic checks](#deep-semantic-checks-deep)). |
| `--json` | No | With `--deep`, emit the structured `VerifyIssue[]` (errors **and** warnings) as JSON for CI consumption. |

Supported extensions:

| Extension | Format |
|---|---|
| `.json` | Strict JSON. Comments/trailing commas are rejected. |
| `.yaml`, `.yml` | YAML — converted in-memory to a map, then validated. |
| `.ts`, `.js`, `.mjs`, `.cjs` | **Refused** — TS/JS inputs are not supported; a module path is refused, never imported. Author maps as JSON or YAML. |

## Behavior

Loads the map via the appropriate path, runs the full [Zod
schema](../maps/format.md#validation) check, then prints either:

**Pass:**

```text
OK: maps/com.example.app/30405.json — com.example.app@3.4.5, 15 class(es), schema_version=4
```

Exit code 0.

**Fail:**

```text
FAIL: maps/com.example.app/30405.json — invalid map
  at classes.com.example.app.IRemoteService$Stub.obfuscated: required
  at classes.com.example.app.Foo.methods.bar.signature: must match /\(.*\)[^()]+/
```

Exit code 1.

## Examples

### JSON

```sh
$ npx rosetta validate maps/com.example.app/30405.json
OK: maps/com.example.app/30405.json — com.example.app@3.4.5, 15 class(es), schema_version=4
```

### YAML

```sh
$ npx rosetta validate maps/com.example.app/3.4.5.yaml
OK: maps/com.example.app/3.4.5.yaml — com.example.app@3.4.5, 15 class(es), schema_version=4
```

### TS/JS module → refused

```sh
$ npx rosetta validate maps/com.example.app/3.4.5.ts
FAIL: maps/com.example.app/3.4.5.ts — TS/JS map modules are no longer supported; author maps as JSON or YAML (path: maps/com.example.app/3.4.5.ts)
```

### Invalid map

```sh
$ npx rosetta validate maps/example/broken.json
FAIL: maps/example/broken.json — invalid map
  at schema_version: Invalid literal value, expected 3
  at classes.com.example.app.Foo.methods: must be an object
```

## What validation checks

1. **Top-level fields.** `schema_version === 3` (a hard literal gate —
   schema 1 and 2 maps are rejected); `app` and `version` are non-empty
   strings; `version_code` is a non-negative integer; `classes` is an
   object. Optional `captured_at` (an ISO `YYYY-MM-DD` date),
   `signer_sha256` (a 64-hex string **or** a non-empty array of them),
   `generated_from` (`{ signatures_rev }`, a 7–40-char git hash), `status`
   (`active`/`superseded`/`retracted`), `superseded_by`, `client_hints`
   (with strict `frida_min_version` / `frida_max_version` sub-keys), and
   `sources` match their declared types when present.
2. **Class entries.** Every entry has `obfuscated: string`. Optional
   fields (`extends`, `kind`, `dex`, `source`, `methods`, `fields`) match
   their declared types when present.
3. **Method entries.** `obfuscated` and `signature` required.
   Multi-overload arrays must be non-empty and have unique
   signatures within one real-name key.
4. **Field entries.** `obfuscated` and `type` required.
5. **Source provenance.** `sources[].tool` required.
6. **Signatures look like JVM descriptors.** `(...args...)return`
   shape with valid character classes.

Validation does **not** check the map matches a running app — that's
the [attach-time health check](../api/session.md#attach-time-health-check)
inside the Frida runtime. `rosetta validate` is purely a static
shape check.

## Deep semantic checks (`--deep`)

The schema proves a map is well-*formed*. `--deep` (alias `--semantic`)
additionally runs the **cross-entry** checks the schema cannot express. This
is the former standalone `verify` verb, folded into `validate` because it took
the same input, the same output shape, and the same exit codes — two verbs
that differed only by check depth. Findings are classified by severity:

**Hard errors** — fail the build (exit 1):

1. **Duplicate obfuscated class names within a dex.** Two real classes sharing
   the same `obfuscated` short name **and** the same `dex` shard collide at
   resolution time. Across different dex shards the same short name is legal
   (R8 reuses `a`/`b`/… per shard), so the check is scoped per `dex`.
2. **Unparseable signatures.** A method `signature` the descriptor parser
   rejects.

**Warnings** — reported but **never** fail the build:

3. **Dangling `extends`.** A class whose `extends` names an app-package real
   class that is not a key in `classes`.
4. **Un-translated arg types.** A method `signature` whose argument descriptors
   reference an app-package real class not in `classes`.

> **Why the cross-reference checks (3, 4) are warnings, not errors.** They rest
> on a heuristic — "a dotted name under the app's package prefix should have a
> map entry." That is a guess: a map is routinely *partial* (you map only what
> you hook), and legitimate vendor/library packages can sit under the app's own
> prefix. An app `com.google.android.apps.foo` legitimately references
> `com.google.android.gms.*` / `com.google.android.material.*` classes it never
> maps. To eliminate those cross-namespace false positives the heuristic
> matches against the **full** `app` package prefix (not a 2-segment slice),
> and the findings are downgraded to warnings so a partial-but-correct map
> never fails on a guess.

```sh
$ npx rosetta validate maps/com.example.app/30405.json --deep
rosetta validate: OK: maps/com.example.app/30405.json — com.example.app@3.4.5, 15 class(es), schema_version=4, consistent

# a heuristic warning is reported but does NOT fail the build (exit 0):
$ npx rosetta validate maps/com.example.app/partial.json --deep
rosetta validate: OK: maps/com.example.app/partial.json — com.example.app@3.4.5, 12 class(es), schema_version=4 (1 warning)
  warning at classes.com.example.app.Child.extends: extends app class 'com.example.app.Base' which is not a key in classes

# a hard error fails (exit 1):
$ npx rosetta validate maps/com.example.app/broken.json --deep
rosetta validate: Map failed semantic verification (1 error)
  at classes.com.example.app.B.obfuscated: obfuscated name 'x' in dex '(no-dex)' collides with class 'com.example.app.A'

# structured output for CI:
$ npx rosetta validate maps/com.example.app/partial.json --deep --json
rosetta validate: [
  { "path": "classes.com.example.app.Child.extends", "message": "...", "severity": "warning" }
]
```

`--deep` is static-only — it inspects a map it is handed and never reads an APK
or *produces* mappings. A future `--device` mode (live health check via
`frida-server`) is deferred; see the [CLI overview](overview.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Map is valid. (With `--deep`: valid and free of hard semantic errors; warnings may still be reported.) |
| `1` | Schema validation failed, file is missing or unreadable, extension is not supported, or — with `--deep` — a hard semantic error was found. |

## CI integration

Validate every map on every PR:

```yaml
# .github/workflows/maps.yml
- name: Validate every map
  run: |
    fail=0
    shopt -s globstar nullglob
    for m in maps/**/*.json maps/**/*.yaml maps/**/*.yml; do
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
    const map = await loadMap('maps/com.example.app/30405.json');
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

For YAML, use `yamlToMap`. Both end up running the same validator
under the hood. (TS/JS-module ingestion was removed for security.)

The deep semantic checks are exported as `verifyMap` (the `--deep` core is a
thin wrapper over it):

```typescript
import { loadMap, verifyMap } from 'rosetta-frida';

const map = await loadMap('maps/com.example.app/30405.json');
const issues = verifyMap(map); // VerifyIssue[] — each has { path, message, severity }
const hardErrors = issues.filter((i) => i.severity === 'error');
if (hardErrors.length > 0) process.exit(1);
```
