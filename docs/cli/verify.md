# `rosetta verify`

Run **deeper-than-schema** consistency checks on a map.
[`validate`](validate.md) proves a map is structurally well-formed (the
canonical schema). `verify` runs the **semantic** checks the schema cannot
express — cross-entry relationships *within one map*.

## Synopsis

```sh
rosetta verify <map>
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<map>` | Yes | Path to a map file (format auto-detected by extension). |

The map is first loaded and schema-validated (a schema failure is reported
exactly like `validate`), then the semantic checks run on top.

## What it checks

1. **Dangling `extends`.** A class whose `extends` names an **app-namespace**
   real class (same package prefix as `app`) that is not itself a key in
   `classes`. A framework superclass (`java.lang.Object`,
   `android.os.Binder`) is a legitimate dotted real name that is never a map
   key and is skipped; an obfuscated parent (no dot) is the deliberate
   "unmapped framework helper" case and is also skipped.
2. **Duplicate obfuscated class names within a dex.** Two real classes
   sharing both the same `obfuscated` short name **and** the same `dex`
   shard collide at resolution time. Across different dex shards the same
   short name is legal (R8 reuses `a`/`b`/... per shard), so the check is
   scoped per `dex`.
3. **Un-translated real-name arg types.** A method `signature` whose
   argument descriptors reference an **app-namespace** dotted class that is
   not a key in `classes` — a sign the signature was authored with a real
   name that never got translated to its obfuscated form. (An unparseable
   signature is also reported.)
4. **`aidl_txn` collisions.** Two method overloads on the **same** class
   sharing an `aidl_txn` transaction code — a binder dispatch ambiguity.

## Examples

```sh
$ npx rosetta verify maps/com.example.app/30405.json
rosetta verify: OK: maps/com.example.app/30405.json — 15 class(es) consistent
```

```sh
$ npx rosetta verify maps/com.example.app/broken.json
rosetta verify: Map failed semantic verification (2 issues)
  at classes.com.example.app.Child.extends: extends app class 'com.example.app.Missing' which is not a key in classes
  at classes.com.example.app.Stub.methods.requestPrompt.aidl_txn: aidl_txn 2 collides with method 'requestTicket' on the same class
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The map is structurally valid and semantically consistent. |
| `1` | Schema validation failed, or one or more semantic checks found a problem. |

`verify` is static-only — it inspects a map it is handed and never reads an
APK or *produces* mappings. A future `--device` mode (live health check via
`frida-server`) is deferred; see the [CLI overview](overview.md).
