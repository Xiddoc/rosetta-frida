# `rosetta pull`

Fetch the single map for an `(app, version_code)` pair from the
community [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo,
validate it against the schema, and write it into your project.

This is a **build-time, developer-machine** operation. The fetch happens
once when you author/bundle a Frida script; the map you pull is then baked
into the compiled bundle (via `frida-compile`). Nothing is ever fetched on
the target device — see the [distribution model](../index.md).

## Synopsis

```sh
rosetta pull <app>@<version_code> [-o <path>] [--force]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<app>@<version_code>` | Yes | The package name and Android `versionCode`, separated by exactly one `@` (e.g. `com.example.app@30405`). The `version_code` must be a positive integer in **decimal digits only** (`1e3`, `+5`, and padded values are rejected). |
| `-o`, `--output <path>` | No | Output path. Defaults to `maps/<app>/<version_code>.json`. |
| `-f`, `--force` | No | Overwrite an existing file at the output path. |

The default output path obeys the canonical `basename == version_code`
invariant. The derived default path is contained to the project tree; an
explicit `-o` may write anywhere but is still rejected if it contains a
NUL byte.

## Behavior

1. **Parse** `<app>@<version_code>` (strict: one `@`, digits-only
   version_code, non-empty app).
2. **Validate config** — the source URL and git ref flow through a typed,
   Zod-validated config (no `process.env` lookups). A malformed base URL
   or empty ref fails fast.
3. **Warn on an unpinned ref.** The default ref is the moving branch
   `main`, which makes pulls non-reproducible. When the ref is not a full
   40-hex commit SHA or a `vX.Y.Z` tag, a warning is printed to stderr.
   **Pin the ref** (SHA or tag) for reproducible build-time bundling.
4. **Fetch** the map from
   `<baseUrl>/<ref>/maps/<app>/<version_code>.json`. The response body is
   bounded (a few MiB); an oversize body is rejected before it is parsed.
5. **Validate** the fetched JSON against the `schema_version: 3` schema.
6. **Identity cross-check.** The fetched map's own `app` and
   `version_code` are compared against the requested pair. A mismatch is a
   hard error — a misfiled upstream file would otherwise be written under
   the wrong name and silently bind the wrong version at runtime.
7. **Write** the map re-rendered in canonical form (4-space indent,
   trailing newline), refusing to overwrite without `--force`.

### Exact-miss fails loudly

A wrong map is worse than no map, so an unknown `(app, version_code)`
(HTTP 404) fails with an actionable message rather than falling back to a
neighbouring version.

### A map is data, not code — no byte-hash sidecar

`pull` does **not** fetch or verify a detached `<version_code>.json.sha256`
byte-hash sidecar. That sidecar was **removed** (maps#37 / frida#21) because
a map can never be more than a *correctness* bug:

- A map is **pure data** — a lookup table the resolver only ever **reads** to
  point at a class/method/field that *already exists* in the app you are
  already running. Nothing in a map is executed, `eval`-ed, or loaded as
  code; it names no file path, URL, shell command, or native symbol. The
  worst a tampered or corrupt map can do is resolve the *wrong* member (a bug
  in your own hook's behaviour) or fail to resolve (a no-op) — never code
  execution.
- **Transport integrity already comes for free from the channel.** Maps are
  acquired over **git-over-HTTPS** at build time on your machine: TLS protects
  the bytes in transit and git is **content-addressed** (every blob is named
  by its own SHA and verified on checkout). A per-file digest sidecar merely
  restated that guarantee without strengthening it.
- **`signer_sha256` is unrelated** — it is an in-map *version* guard that
  answers "is this the app build this map was written for?" (a stale/mismatched
  map is a correctness hazard), checked on-device. It was never a
  transport-integrity or publisher-authenticity control.

If publisher authenticity is ever wanted (proving *who* published a map, not
merely that the bytes are intact), that folds into the separate, opt-in
**attestation** tier — a detached signature over the map's digest — not a
byte-hash sidecar. The single source of truth for this safety model is the
rosetta-maps
[`docs/reference/integrity.md`](https://github.com/Xiddoc/rosetta-maps/blob/main/docs/reference/integrity.md).

## Examples

### Default path

```sh
$ npx rosetta pull com.example.app@30405
rosetta pull: wrote maps/com.example.app/30405.json
```

### Custom path

```sh
$ npx rosetta pull com.example.app@30405 -o vendor/maps/example.json
rosetta pull: wrote vendor/maps/example.json
```

### Exact miss (unknown version)

```sh
$ npx rosetta pull com.example.app@99999
rosetta pull: no map found for com.example.app@99999 in the rosetta-maps repo (HTTP 404 at …). Check that the app name and version_code are correct, or contribute a map at https://github.com/Xiddoc/rosetta-maps
```

### Identity mismatch (misfiled upstream map)

```sh
$ npx rosetta pull com.example.app@30405
rosetta pull: fetched map identity does not match the request: expected com.example.app@30405 but the map declares com.example.app@30406. Refusing to write a misfiled map.
```

### Unpinned ref warning (default `main`)

```sh
$ npx rosetta pull com.example.app@30405 -o m.json
warning: mapsRepoRef 'main' is not pinned — pulls are not reproducible. Pin a full 40-hex commit SHA or a 'vX.Y.Z' tag for reproducible build-time bundling.
rosetta pull: wrote m.json
```

### Bad target

```sh
$ npx rosetta pull com.example.app@1e3
rosetta pull: version_code in 'com.example.app@1e3' must be a positive integer (decimal digits only); got '1e3'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Map fetched, validated, and written. |
| `1` | Bad arguments, exact miss (404), oversize/invalid/identity-mismatched map, target exists and `--force` not passed, network or filesystem error. |

## Notes

- Maps are acquired and bundled at **build time**, never on the device.
  `pull` is the thin ergonomic over the git/GitHub source of truth; a
  `git submodule` / sparse-checkout of the maps repo is the zero-tooling
  fallback.
- Validation runs as part of the pull, so a successful `pull` implies a
  passing [`rosetta validate`](validate.md).

See the [CLI overview](overview.md) for the full command list.
