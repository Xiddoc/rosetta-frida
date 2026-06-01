# `rosetta extract`

Pull the embedded map out of a compiled bundle into a standalone
JSON file.

## Synopsis

```sh
rosetta extract <bundle.js> -o <out.json>
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<bundle.js>` | Yes | Compiled `.js` bundle containing a marker block. |
| `-o`, `--output <path>` | Yes | Output JSON path. |

## Behavior

1. Read `<bundle.js>` from disk.
2. [`parseMarkerBlock`](../maps/marker-block.md#parsemarkerblockbundlesrc)
   to extract the embedded payload.
3. Write the payload as pretty-printed JSON (2-space indent — terser
   than the 4-space indent inside the marker block, sized for
   readability as a standalone diff target).
4. For registry bundles, the whole `__rosetta_maps` object is
   written. Single-map bundles write just the one `RosettaMap`.

## Examples

### Single-map bundle

```sh
$ npx rosetta extract hook.bundle.js -o extracted.json
extract: wrote extracted.json (single)

$ head -3 extracted.json
{
  "schema_version": 2,
  "app": "com.example.app",
```

### Registry bundle

```sh
$ npx rosetta extract hook.multi.bundle.js -o extracted.json
extract: wrote extracted.json (registry)

$ jq 'keys' extracted.json
[
  "3.4.5",
  "3.4.6",
  "3.5.0"
]
```

### No marker block

```sh
$ npx rosetta extract raw-bundle.js -o out.json
extract: no rosetta-frida marker block found in bundle
```

## Output format

The extracted file is **pure strict JSON**. Comments and
formatting from the original source do not survive — only the
canonical data does.

The kind suffix (`single` or `registry`) printed on stdout matches
what's in the file, so downstream tools can decide how to load:

```sh
kind=$(npx rosetta extract hook.bundle.js -o /dev/null 2>&1 | awk -F'[()]' '{print $2}')
case "$kind" in
    single)   echo "single-map bundle" ;;
    registry) echo "multi-version bundle" ;;
esac
```

## Use cases

- **Audit** what a compiled bundle is targeting before deploying.
- **Diff** the embedded map against the source of truth, to catch
  build drift.
- **Migration** — extract from an old bundle, edit, patch back in.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Extraction succeeded. |
| `1` | Bad arguments, IO error, or no marker block found. |

## Programmatic equivalent

```typescript
import { parseMarkerBlock } from 'rosetta-frida';
import { readFile, writeFile } from 'node:fs/promises';

const bundle = await readFile('hook.bundle.js', 'utf8');
const parsed = parseMarkerBlock(bundle);
const payload = parsed.kind === 'single' ? parsed.map : parsed.maps;
await writeFile('extracted.json', JSON.stringify(payload, null, 2) + '\n', 'utf8');
```

## Related

- [`rosetta inspect`](inspect.md) — for a one-line summary without
  writing a file.
- [`rosetta patch`](patch.md) — for the reverse direction (replace
  the embedded map).
- [Marker block — `parseMarkerBlock`](../maps/marker-block.md#parsemarkerblockbundlesrc)
  for the full programmatic surface.
