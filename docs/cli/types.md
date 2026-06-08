# `rosetta types`

Emit a TypeScript declaration (`.d.ts`) for a map's **real names** so hook
authors get editor autocompletion and a build can flag a stale name.

Hook authors write against real (unobfuscated) names through
`rosetta.use(...)` / `rosetta.hook(...)`. Those names are stringly-typed at
the call site, so a typo (`requestTickett`) is only caught at runtime. This
verb turns a map into string-literal unions an editor can complete against.

## Synopsis

```sh
rosetta types <map> -o <out.d.ts> [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<map>` | Yes | Path to a map file (format auto-detected by extension). |
| `-o`, `--output <path>` | Yes | Where to write the `.d.ts` stub. |
| `--force`, `-f` | No | Overwrite an existing output file. |

## What it emits

The generated module declares:

- `RosettaClassName` — a union of every real class name.
- `RosettaMethodName` — a union of `Class.method` for every real method
  (the `rosetta.hook(...)` tier-1 target shape).
- `RosettaFieldName` — a union of `Class.field`.
- `RosettaRealNames` — an interface mapping each class to its method and
  field name unions, for richer per-class typing.

Empty unions render as `never`. Output is deterministic — names are sorted,
so the same map always produces byte-identical output. The stub contains
**only real names**; it never emits obfuscated names (those rotate — that is
the whole point).

Every emitted string literal is rendered with `JSON.stringify`, so a
schema-legal class/method/field name containing a quote or backslash produces
a valid, fully-escaped double-quoted literal (a single-quoted literal would be
a syntax error). The generated JSDoc header also sanitizes any block-comment
terminator out of the interpolated `app` / `version` so a hostile or unusual
`version` cannot break out of the comment block.

## Example

```sh
$ npx rosetta types maps/com.example.app/30405.json -o types/com.example.app.d.ts
rosetta types: wrote types/com.example.app.d.ts
```

```ts
// types/com.example.app.d.ts (excerpt)
export type RosettaClassName = "com.example.app.IRemoteService$Stub" | ...;
export type RosettaMethodName = "com.example.app.IRemoteService$Stub.requestTicket" | ...;
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Stub written. |
| `1` | Bad args, the input is missing/invalid, or a refused overwrite. |

## Programmatic equivalent

`renderTypes` and `collectNames` are exported from the package root (the CLI
verb is a thin wrapper):

```typescript
import { loadMap, renderTypes } from 'rosetta-frida';

const map = await loadMap('maps/com.example.app/30405.json');
const dts = renderTypes(map); // the full .d.ts text
```
