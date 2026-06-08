# `rosetta merge`

Combine several partial maps for the **same** `(app, version_code)` into one
canonical map. A single version's map is typically assembled from several
sources — a sigmatcher run, hand-authored entries, and
rosetta-runtime-discovered names — each emitted as its own partial map.
`merge` folds them into one artifact.

## Synopsis

```sh
rosetta merge <a> <b> [<c> ...] -o <out.json> [--strict] [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<a> <b> [...]` | Yes (≥ 2) | Input maps, in **precedence order** (last-wins). |
| `-o`, `--output <path>` | Yes | Where to write the merged JSON. |
| `--strict` | No | Fail on a *conflicting* obfuscated name instead of last-wins. |
| `--force`, `-f` | No | Overwrite an existing output file. |

All inputs must share the same `app` and `version_code` (a mismatch is an
error — a map is per `(app, version_code)`).

## Conflict policy (deterministic)

Inputs are merged **left-to-right**; for any key in more than one input,
**last-wins** — a later input on the command line overrides an earlier one.
Put your highest-trust source last. The fold is recursive:

- **Top-level scalar identity** (`app`, `version`, `version_code`,
  `captured_at`, ...) — last-wins. An *undefined* optional on a later input
  never erases a value an earlier input set.
- **`sources[]`** — concatenated in order (provenance is additive, never
  dropped).
- **`classes[realName]`** — merged entry-by-entry: a class in both has its
  `methods` and `fields` unioned (last-wins per real name; method overloads
  paired by signature) and its scalar fields last-win.

An *undefined* class-scalar on a later input (an explicit hole, e.g. a class
re-stated without its `extends`) likewise never erases the base value — the
same undefined-stripping applied at the top level is applied per class.

In non-strict mode, every last-wins override of an *obfuscated* name — the
"silent wrong name corrupts hooks" hazard — emits a `note:` line to **stderr**
so the operator sees exactly what got overridden (the merge still succeeds).

With `--strict`, two inputs that map the same real name (class, method
overload, or field) to **different** obfuscated names is a hard error
rather than a silent last-wins pick. Identical values never conflict. This
is the "fail hard by default" posture made opt-in for merges, where
overlaying a refined source on a coarse one is a legitimate override.

The merged result is re-validated against the canonical schema before it is
written, so a fold that produced an invalid shape (e.g. an overload set that
overflowed the per-method cap) fails loudly.

## Examples

```sh
# sigmatcher first (coarse), hand-authored last (authoritative overrides)
$ npx rosetta merge maps/app/sigmatcher.json maps/app/hand.json -o maps/app/30405.json
rosetta merge: wrote maps/app/30405.json

# non-strict override surfaces a stderr note (merge still succeeds)
$ npx rosetta merge sigmatcher.json hand.json -o out.json
note: class 'com.example.app.Foo' obfuscated name overridden 'aaaa' -> 'bbbb' (last input wins; pass --strict to fail instead)
rosetta merge: wrote out.json

# fail if two sources disagree on an obfuscated name
$ npx rosetta merge a.json b.json -o out.json --strict
rosetta merge: conflicting obfuscated name for class 'com.example.app.Foo': 'aaaa' vs 'bbbb' (merge without strict mode to take the last input's value)
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Merged and written. |
| `1` | Bad args, an input missing/invalid, identity mismatch, a `--strict` conflict, an invalid fold, or a refused overwrite. |

## Programmatic equivalent

`mergeMaps` is exported from the package root (the CLI verb is a thin
wrapper). It takes an **options object** (`{ strict, onOverride }`):

```typescript
import { loadMap, mergeMaps } from 'rosetta-frida';

const maps = await Promise.all(['sigmatcher.json', 'hand.json'].map((p) => loadMap(p)));
const merged = mergeMaps(maps, {
    strict: false,
    onOverride: (o) => console.warn(`overrode ${o.kind} ${o.name}: ${o.from} -> ${o.to}`),
});
```
