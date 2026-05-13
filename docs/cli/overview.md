# CLI overview

The `rosetta` binary ships with the npm package. Invoke it via
`npx rosetta <command>`, or directly via `node_modules/.bin/rosetta`,
or wire it into a `package.json` script.

## Commands

```text
$ npx rosetta --help
Usage: rosetta <command> [options]

Commands:
  init <app> <version>                 Scaffold a new map skeleton
  validate <map>                       Schema + sanity check (auto-detect format)
  convert <in> -o <out>                Convert YAML/TS module to canonical JSONC
  patch <bundle.js> --map <new.json>   Replace embedded map in bundle
  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle
  inspect <bundle.js>                  One-line summary of embedded map
```

| Command | What it does | Operates on |
|---|---|---|
| [`init`](init.md) | Scaffold a JSONC skeleton for a new `(app, version)` pair. | The filesystem — writes `maps/<app>/<version>.json` by default. |
| [`validate`](validate.md) | Run the schema + sanity check against a map. Auto-detects format from the extension. | One map file (JSONC / YAML / TS module). |
| [`convert`](convert.md) | Convert a YAML or TS-module map to canonical JSONC. | One map file. |
| [`patch`](patch.md) | Replace the embedded map in a compiled bundle with a fresh one. In-place by default. | A compiled bundle + a new map. |
| [`extract`](extract.md) | Pull the embedded map back out of a compiled bundle into a standalone JSON file. | A compiled bundle. |
| [`inspect`](inspect.md) | Print a one-line summary of the map embedded in a compiled bundle. | A compiled bundle. |

## Two command shapes

Internally the CLI has two flavors of command:

- **Map authoring** — `init`, `validate`, `convert`. These take an
  optional `fsImpl` parameter under the hood, return a result value,
  and surface `RosettaError`s with exit code 1.
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
        "build:hook": "frida-compile hook.ts -o hook.bundle.js && rosetta patch hook.bundle.js --map maps/com.example.app/3.4.5.jsonc",
        "validate:maps": "rosetta validate maps/com.example.app/3.4.5.jsonc"
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

## What's not in V1

The following commands are planned for V1.5 but not in V1.0:

- `rosetta diff <a.json> <b.json>` — show rotation deltas between
  versions (the canonical "what changed in this release" report).
- `rosetta merge <a.json> <b.json> [...]` — merge partial maps,
  preferring higher-confidence entries.
- `rosetta merge-bundle <bundle.js> <map1.json> [...]` — convert a
  single-map bundle to a registry bundle.
- `rosetta types <map.json> -o <out.d.ts>` — generate per-map
  TypeScript declarations.
- `rosetta migrate <map.json>` — run schema migrators on old maps.
- `rosetta verify --device <id>` — live health check via
  `frida-server`.
- `rosetta fetch <app> <version>` — pull from a public registry (V2+).

Stay tuned for V1.5.
