# `rosetta diff`

Report what *rotated* between two maps: the classes, methods, and fields
that were added, removed, renamed (obfuscated-name change), or re-signed
(method signature change). This is the canonical "what changed in this
release" report — the obfuscation-rotation churn rosetta-frida exists to
absorb.

## Synopsis

```sh
rosetta diff <from> <to> [--json]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<from>` | Yes | The old / left map (format auto-detected by extension). |
| `<to>` | Yes | The new / right map. |
| `--json` | No | Emit a machine-readable JSON object instead of the human report. |

Both inputs are loaded through the same path as [`validate`](validate.md),
so a malformed input fails loudly rather than producing a bogus diff. The
two maps must be for the same `app` (a cross-app diff is an error).

## How it works

The diff is computed over **real names** (the map keys) — the stable
identity across versions — and reports how each real name's *obfuscated*
spelling moved:

- **Classes** present in `to` but not `from` are `+ class`; the reverse is
  `- class`. A class in both whose `obfuscated` changed is reported as a
  rename on the class header.
- **Methods** are paired by **signature** first (to catch a pure
  obfuscated-name rename), then positionally (to catch a signature
  re-sign). Added / removed real method names are listed too.
- **Fields** are matched by real name; an `obfuscated` change is a rename.

## Examples

### Human report (default)

```sh
$ npx rosetta diff maps/com.example.app/30405.json maps/com.example.app/30406.json
rosetta diff: com.example.app: 30405 -> 30406
  ~ com.example.app.IRemoteService$Stub (obfuscated aaaa -> zzzz)
      method requestTicket: obfuscated c -> e
  + class com.example.app.NewService
```

### Machine output

```sh
$ npx rosetta diff old.json new.json --json
rosetta diff: {
  "app": "com.example.app",
  "fromVersionCode": 30405,
  "toVersionCode": 30406,
  "classesAdded": ["com.example.app.NewService"],
  "classesRemoved": [],
  "classesChanged": [ ... ]
}
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Diff computed (whether or not there were changes). |
| `1` | An input was missing/unreadable/invalid, or the two maps are for different apps. |

`diff` is read-only: it never writes a file, and it does not *produce*
mappings (it is not a deobfuscator) — it only compares maps it is handed.
