# `rosetta inspect`

Print a one-line summary of the map embedded in a compiled bundle.
Designed to be greppable in CI output — no JSON, no fluff.

## Synopsis

```sh
rosetta inspect <bundle.js>
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<bundle.js>` | Yes | Compiled `.js` bundle containing a marker block. |

## Output formats

### Single-map bundle

```text
<app>@<version>, schema_version <N>, <K> classes
```

Example:

```sh
$ npx rosetta inspect hook.bundle.js
com.example.app@3.4.5, schema_version 4, 15 classes
```

### Registry bundle

```text
registry: <app>, versions=[<v1>, <v2>, ...], <K> classes total
```

Example:

```sh
$ npx rosetta inspect hook.multi.bundle.js
registry: com.example.app, versions=[3.4.5, 3.4.6, 3.5.0], 45 classes total
```

If the registry contains maps for multiple apps (unusual but
supported), the app field reads `mixed`:

```sh
$ npx rosetta inspect mixed.multi.bundle.js
registry: mixed, versions=[3.4.5, 1.0.0], 32 classes total
```

## Use cases

- **CI smoke check** — quick "is this the right bundle" before
  deploying.
- **Pre-deploy audit** — confirm the map version matches the target
  app version.
- **Bundle dredging** — find the map version inside an old build
  artifact you don't have source for.

## Examples

### Smoke-check in a deploy step

```sh
$ npx rosetta inspect dist/hook.bundle.js | grep -q "com.example.app@3.5.0" || exit 1
```

### Grep for class count

```sh
$ npx rosetta inspect hook.bundle.js | awk -F', ' '{print $3}'
15 classes
```

### Multi-bundle survey

```sh
$ for b in dist/*.bundle.js; do
    echo -n "$b: "
    npx rosetta inspect "$b"
done
dist/hook-3.4.5.bundle.js: com.example.app@3.4.5, schema_version 4, 15 classes
dist/hook-3.4.6.bundle.js: com.example.app@3.4.6, schema_version 4, 15 classes
dist/hook-3.5.0.bundle.js:  com.example.app@3.5.0, schema_version 4, 15 classes
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Inspection succeeded; one-liner printed to stdout. |
| `1` | Bad arguments, IO error, or no marker block found. |

## What it does *not* do

- **It does not validate the embedded map's schema.** It only counts
  classes and reads the header metadata. Run `rosetta extract` +
  `rosetta validate` if you want full validation.
- **It does not connect to a device.** Purely a static scan of the
  bundle file.
- **It does not show diffs** between bundles. Run `rosetta extract`
  on both and diff the outputs.

## Programmatic equivalent

```typescript
import { parseMarkerBlock } from 'rosetta-frida';
import { readFile } from 'node:fs/promises';

const bundle = await readFile('hook.bundle.js', 'utf8');
const parsed = parseMarkerBlock(bundle);

if (parsed.kind === 'single') {
    const m = parsed.map;
    const classes = Object.keys(m.classes).length;
    console.log(`${m.app}@${m.version}, schema_version ${m.schema_version}, ${classes} classes`);
} else {
    const versions = Object.keys(parsed.maps);
    let total = 0;
    const apps = new Set<string>();
    for (const v of versions) {
        const m = parsed.maps[v]!;
        apps.add(m.app);
        total += Object.keys(m.classes).length;
    }
    const app = apps.size === 1 ? [...apps][0] : 'mixed';
    console.log(`registry: ${app}, versions=[${versions.join(', ')}], ${total} classes total`);
}
```
