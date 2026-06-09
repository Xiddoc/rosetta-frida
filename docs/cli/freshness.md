# `rosetta freshness`

Flag which of your **vendored** maps have fallen behind the current
signatures — i.e. omit a class that a signature rule now defines — so you
know which maps to regenerate. It is **read-only and advisory**: a stale
map is normal and never fails the command.

This is the zero-toolchain, **consumer twin** of the maps-side CI check.
The authoritative detection runs in the
[`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo on every PR
(`scripts/check_map_freshness.py`); `rosetta freshness` runs the
**identical computation** locally against maps you have already pulled
into your own project. It requires no APK and does no network I/O — it
reads only the map files and the signatures file you point it at.

## Synopsis

```sh
rosetta freshness <map...> --signatures <signatures.yaml> [--json]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<map...>` | Yes | One or more vendored map paths. Expand a directory/glob at the shell, e.g. `maps/**/*.json`. Each map's app is its parent directory name and its `version_code` is the filename, matching the `maps/<app>/<version_code>.json` layout. |
| `-s`, `--signatures <path>` | Yes | Path to the `signatures.yaml` source of truth. Its app is its parent directory name (`signatures/<app>/signatures.yaml`); only maps for that app get an expectation set. |
| `--json` | No | Emit the structured findings as JSON instead of the human report. |

## The algorithm

The computation is the **shared cross-repo contract** — it matches the
maps-side check byte-for-byte so a map's freshness is the same on both
sides:

1. Parse `signatures.yaml` to the **set of real fully-qualified class
   names** its class rules claim to find. A rule's FQN is
   `<package>.<name>`, with sigmatcher's `$`-nesting carried through
   verbatim: a rule `name: 'IRemoteService$Stub'` with
   `package: 'com.example.app'` yields the FQN
   `com.example.app.IRemoteService$Stub` — exactly the spelling of a
   map's `classes` key. (No `$`→`.` rewrite.)
2. For each map, take the **set of its `classes` keys**.
3. `missing = ruleFQNs − mapClassKeys`. A non-empty `missing` means the
   map is **stale** — it omits a class the current signatures define a
   rule for.

A map containing every ruled class (a superset is fine) is **fresh** and
not reported. A map for an app with no signatures sets no expectation and
is never flagged.

## Advisory by design

A stale map is **normal and mergeable**: a signatures-only change that
adds a class rule legitimately strands every older map until you
regenerate it on your own cadence. So a staleness finding **never** fails
the command — `freshness` prints its report and exits 0.

A non-zero exit (1) is reserved **exclusively** for the verb's own
malformed inputs:

- an unreadable signatures or map path;
- garbled signatures YAML or map JSON;
- a signatures doc that is not a non-empty list of rule mappings;
- a map whose `classes` is not an object.

These are real breakage the schema validators reject too — everything
else is advisory.

## Examples

### A stale map

```sh
$ npx rosetta freshness maps/com.example.app/30404.json \
    --signatures signatures/com.example.app/signatures.yaml
rosetta freshness: 1 stale map(s) of 1 checked (advisory — regenerate when convenient):
  maps/com.example.app/30404.json (com.example.app@30404) — missing 1:
    com.example.app.Config
```

Exit code 0 — it is advisory.

### Every map fresh

```sh
$ npx rosetta freshness maps/com.example.app/30405.json \
    --signatures signatures/com.example.app/signatures.yaml
rosetta freshness: all 1 map(s) fresh against the current signatures (1 app(s) with signatures)
```

### A whole vendored corpus (shell glob)

```sh
$ npx rosetta freshness maps/com.example.app/*.json \
    --signatures signatures/com.example.app/signatures.yaml
```

### Structured output for tooling

```sh
$ npx rosetta freshness maps/com.example.app/30404.json \
    --signatures signatures/com.example.app/signatures.yaml --json
rosetta freshness: [
  {
    "mapPath": "maps/com.example.app/30404.json",
    "app": "com.example.app",
    "versionCode": "30404",
    "missing": ["com.example.app.Config"]
  }
]
```

### A malformed input fails (exit 1)

```sh
$ npx rosetta freshness maps/com.example.app/broken.json \
    --signatures signatures/com.example.app/signatures.yaml
rosetta freshness: maps/com.example.app/broken.json: could not parse JSON: ...
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run completed — including when maps are stale (advisory). |
| `1` | A malformed or unreadable input (bad YAML/JSON, wrong-shaped doc, unreadable path). |

## The fix path

`freshness` only *detects* drift; it does not regenerate maps. The fix is
to re-run your map generator (sigmatcher against the APK, or a hand
re-author) for the stale `(app, version_code)` and re-validate with
[`rosetta validate`](validate.md). A dedicated `regen` verb that
automates regeneration is a planned future addition; until then,
regeneration is a manual step on your own cadence.

The authoritative drift dashboard runs in the
[`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) CI; this verb
gives you the same signal locally for the subset of maps you vendored.

## Programmatic equivalent

```typescript
import { analyseFreshness, renderFreshnessReport, type MapClassKeys } from 'rosetta-frida';

const sigByApp = new Map([['com.example.app', new Set(['com.example.app.Config'])]]);
const maps: MapClassKeys[] = [
    {
        mapPath: 'maps/com.example.app/30404.json',
        app: 'com.example.app',
        versionCode: '30404',
        classKeys: new Set(['com.example.app.IRemoteService$Stub']),
    },
];

const report = analyseFreshness(maps, sigByApp);
console.log(renderFreshnessReport(report)); // human report; report.findings is structured
```

The lower-level parsers (`parseSignatures`, `parseMapClassKeys`) are
exported from `src/freshness/` for callers that want to read the inputs
themselves.
