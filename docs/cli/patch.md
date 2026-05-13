# `rosetta patch`

Replace the embedded map in a compiled bundle with a freshly emitted
block sourced from a new map. In-place by default.

## Synopsis

```sh
rosetta patch <bundle.js> --map <new.jsonc> [-o <out.js>]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<bundle.js>` | Yes | Compiled `.js` bundle containing a marker block to replace. |
| `--map <path>` | Yes | Path to the new map (JSONC or JSON). Single-map or registry. |
| `-o`, `--output <path>` | No | Output path. Defaults to in-place (the input bundle is rewritten). |

The new map is parsed via `parseJsonc`, so both JSONC source (comments
+ trailing commas) and strict JSON are accepted. For full schema
validation, run [`rosetta validate`](validate.md) on the map first —
`patch` only checks enough structure to pick single-map vs registry
emission.

## Behavior

1. Read `<bundle.js>` from disk.
2. Read `<new.jsonc>` and parse it via `parseJsonc`. Heuristically
   detect single-map vs registry by presence of `schema_version` at
   the top level.
3. Call [`patchMarkerBlock(bundle, payload)`](../maps/marker-block.md#patchmarkerblockbundlesrc-newpayload)
   to splice in a fresh marker block.
4. Write the result to the output path (in-place by default).

If the bundle has no existing marker block, the call surfaces a
[`MarkerBlockError`](../reference/errors.md#markerblockerror).

## Examples

### In-place patch

The default — useful in CI where you compile once and patch per
environment:

```sh
$ npx rosetta patch hook.bundle.js --map maps/com.example.app/3.5.0.jsonc
patch: wrote hook.bundle.js (in place)
```

### Patch to a new file

Keep the original around, write the result somewhere else:

```sh
$ npx rosetta patch hook.bundle.js \
    --map maps/com.example.app/3.5.0.jsonc \
    -o hook-3.5.0.bundle.js
patch: wrote hook-3.5.0.bundle.js
```

### Patch with a registry map

The new map can be a multi-version registry; patch writes the full
registry block (and the runtime picks the right entry by detected
version):

```sh
$ npx rosetta patch hook.bundle.js --map maps/com.example.app/registry.jsonc
patch: wrote hook.bundle.js (in place)
```

### Bundle has no marker block

```sh
$ npx rosetta patch raw-bundle.js --map maps/com.example.app/3.5.0.jsonc
patch: no rosetta-frida marker block found in bundle
```

If you're patching a bundle for the first time, the marker block
needs to already be there (either via the manual marker-wrapping
recipe or, in the future, the `frida-compile` plugin). `patch`
replaces an existing block; it doesn't create one.

## CI pattern — compile once, patch per environment

```sh
# Build phase (one-time):
npx frida-compile hook.ts -o hook.bundle.js
# ... + manual marker-block wrapping (until frida-compile plugin) ...

# Deploy phase (per environment):
for v in 3.4.5 3.4.6 3.5.0; do
    npx rosetta patch hook.bundle.js \
        --map maps/com.example.app/$v.jsonc \
        -o "dist/hook-$v.bundle.js"
done
```

Each output bundle has the same hook source, just a different
embedded map. Pick the right one for each device or environment at
deploy time.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Patch succeeded. |
| `1` | Bad arguments, IO error, missing marker block, or malformed map source. |

## Programmatic equivalent

```typescript
import { patchMarkerBlock, parseJsonc } from 'rosetta-frida';
import { readFile, writeFile } from 'node:fs/promises';

const bundle = await readFile('hook.bundle.js', 'utf8');
const map = parseJsonc(await readFile('maps/com.example.app/3.5.0.jsonc', 'utf8'));
const patched = patchMarkerBlock(bundle, map);
await writeFile('hook.bundle.js', patched, 'utf8');
```

See [Marker block](../maps/marker-block.md#programmatic-api) for the
full programmatic surface.

## Related

- [`rosetta inspect`](inspect.md) — verify the patch by reading the
  one-liner.
- [`rosetta extract`](extract.md) — pull the embedded map back out
  to compare against the source.
