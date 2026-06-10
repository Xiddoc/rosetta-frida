# CLI overview

The `rosetta` CLI ships with the npm package: after
`npm install rosetta-frida`, run `npx rosetta <command>` (or the
`node_modules/.bin/rosetta` binary). From a source checkout, run it with
`npm run cli -- <command>` instead (the examples below show
`rosetta <command>` for brevity).

## Commands

```text
$ npx rosetta --help
Usage: rosetta <command> [options]

Commands:
  init <app> <version> [options]            Scaffold a new map skeleton (--version-code required)
  pull <app>@<version_code> [options]       Fetch + validate a map from the rosetta-maps repo
  validate <map> [--deep]                   Schema check (+ --deep semantic checks; --json)
  convert <in> -o <out>                     Convert YAML map to canonical JSON
  patch <bundle.js> --map <new.json>        Replace embedded map in bundle
  extract <bundle.js> -o <out.json>         Pull embedded map out of bundle
  inspect <bundle.js>                       One-line summary of embedded map
  diff <from> <to> [--json] [--exit-code]   Structural diff between two maps (what rotated)
  merge <a> <b> [...] -o <out> [--strict]   Combine partial maps for one (app, version_code)
  types <map> -o <out.d.ts>                 Emit .d.ts real-name stubs for autocompletion
```

| Command | What it does | Operates on |
|---|---|---|
| [`init`](init.md) | Scaffold a strict-JSON skeleton for a new `(app, version)` pair (`--version-code` required). | The filesystem — writes `maps/<app>/<version_code>.json` by default. |
| [`pull`](pull.md) | Fetch the verified map for an `(app, version_code)` from the community rosetta-maps repo, validate it, and write it into the project. Build-time only. | The network (read) + the filesystem (write). |
| [`validate`](validate.md) | Run the schema + sanity check against a map (auto-detects format). `--deep` adds semantic checks (dangling `extends`, duplicate obfuscated names per dex, un-translated arg types, unparseable signatures); `--json` for CI. | One map file (JSON / YAML). |
| [`convert`](convert.md) | Convert a YAML map to canonical JSON. | One map file. |
| [`patch`](patch.md) | Replace the embedded map in a compiled bundle with a fresh one. In-place by default. | A compiled bundle + a new map. |
| [`extract`](extract.md) | Pull the embedded map back out of a compiled bundle into a standalone JSON file. | A compiled bundle. |
| [`inspect`](inspect.md) | Print a one-line summary of the map embedded in a compiled bundle. | A compiled bundle. |
| [`diff`](diff.md) | Report what rotated (classes/methods/fields/signatures) between two maps. Human report + `--json`; `--exit-code` gates CI on drift. | Two map files. |
| [`merge`](merge.md) | Combine several partial maps for one `(app, version_code)` into one (sources unioned, entries merged; `--strict` errors on conflicting obfuscated names). | Two or more map files. |
| [`types`](types.md) | Emit a `.d.ts` of the map's real names so hook authors get autocompletion. | One map file. |

## Two command shapes

Internally the CLI has two flavors of command:

- **Map authoring** — `init`, `pull`, `validate`, `convert`. These
  take an optional `fsImpl` parameter under the hood (and, for `pull`, an
  injected `fetch` seam), return a result value, and surface `RosettaError`s
  with exit code 1.
- **Bundle manipulation** — `patch`, `extract`, `inspect`. These
  operate against a compiled bundle via the marker block and use a
  shared `CommandIo` injection so the same logic can run under tests
  with mock fs.

The user-visible surface is identical — every command takes its
arguments on the command line and writes its result to stdout or a
named output file.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Command failed — bad args, validation failure, IO error, map not found, etc. Reason printed to stderr. |
| `2` | Unexpected internal error. Shouldn't happen; please file an issue. |

## CLI conventions

- **Positional args first**, then flags. Most commands take exactly
  one positional argument (a path) plus a small number of flags.
- **`-o <path>` for output paths.** Where applicable. Default
  behavior is documented per-command (sometimes in-place; sometimes
  a default path under `maps/`).
- **`--force` / `-f` to overwrite existing files.** Without it,
  destructive commands refuse to clobber and exit 1.
- **No interactive prompts.** Every command is batch-safe and
  pipeline-friendly.
- **Errors on stderr, results on stdout.** Standard Unix discipline.

## Integration patterns

### npm scripts

```json
{
    "scripts": {
        "build:hook": "frida-compile hook.ts -o hook.bundle.js && rosetta patch hook.bundle.js --map maps/com.example.app/30405.json",
        "validate:maps": "rosetta validate maps/com.example.app/30405.json"
    }
}
```

### CI map validation

```yaml
# .github/workflows/maps.yml
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install
      - name: Validate every map
        run: |
          shopt -s globstar nullglob
          for m in maps/**/*.json; do
            npx rosetta validate "$m" || exit 1
          done
```

### Per-environment maps in CI

Compile the bundle once, swap maps per environment:

```sh
# Build phase (one-shot in CI):
npx frida-compile hook.ts -o hook.bundle.js

# Deploy phase (per environment):
npx rosetta patch hook.bundle.js --map maps/com.example.app/${VERSION}.json -o hook-${VERSION}.bundle.js
```

This is the CI flow the marker block was designed for. See
[Marker block](../maps/marker-block.md) for the full mechanism.

## Shipped in V1.5

The map-authoring verbs once listed here as deferred have landed:
[`diff`](diff.md), [`merge`](merge.md), [`types`](types.md), and the deep
semantic checks under [`validate --deep`](validate.md#deep-semantic-checks-deep).
See their pages for the full grammar.

> **Surface changes (review).** The `merge-bundle` alias was dropped (it was a
> verbatim duplicate of `merge`). The standalone `verify` verb was folded into
> `validate --deep` — it took the same input, output shape, and exit codes and
> differed only by check depth. The semantic engine remains available
> programmatically as `verifyMap` (exported from the package root).

## Still deferred

- `rosetta migrate <map.json>` — run schema migrators on old maps
  (tracked with the rosetta-maps schema-evolution work; the schema owner
  defines the migration contract).
- `rosetta validate --device <id>` — a *live* health check via
  `frida-server`. Today's [`validate --deep`](validate.md#deep-semantic-checks-deep)
  is static-only (semantic checks on a map it is handed); a device-backed mode
  is future work.
- A `frida-compile` plugin for automatic marker-block wrapping.

> The build-time community-registry fetch (once sketched as
> `rosetta fetch`) **shipped in V1.0 as [`rosetta pull`](pull.md)**. It
> pulls the single verified map for an `(app, version_code)` from the
> rosetta-maps repo on the developer's machine.
