# `rosetta pull`

Fetch the single verified map for an `(app, version_code)` pair from the
community [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo,
validate it against the schema, and write it into your project.

This is a **build-time, developer-machine** operation. The fetch happens
once when you author/bundle a Frida script; the map you pull is then baked
into the compiled bundle (via `frida-compile`). Nothing is ever fetched on
the target device — see the [distribution model](../index.md).

## Synopsis

```sh
rosetta pull <app>@<version_code> [-o <path>] [--force] [--require-sidecar]
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<app>@<version_code>` | Yes | The package name and Android `versionCode`, separated by exactly one `@` (e.g. `com.example.app@30405`). The `version_code` must be a positive integer in **decimal digits only** (`1e3`, `+5`, and padded values are rejected). |
| `-o`, `--output <path>` | No | Output path. Defaults to `maps/<app>/<version_code>.json`. |
| `-f`, `--force` | No | Overwrite an existing file at the output path. |
| `--require-sidecar` | No | Fail closed when the map's detached `.json.sha256` sidecar is **absent**. Default (during rollout) is to warn and proceed on a missing sidecar; a sidecar that is **present** is always verified regardless of this flag. |

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
5. **Verify the transport-integrity sidecar** (see below) against the
   **exact raw fetched bytes**, before they are parsed or trusted. A
   mismatched or malformed sidecar fails closed; a missing one warns (or
   fails closed under `--require-sidecar`).
6. **Validate** the fetched JSON against the `schema_version: 2` schema.
7. **Identity cross-check.** The fetched map's own `app` and
   `version_code` are compared against the requested pair. A mismatch is a
   hard error — a misfiled upstream file would otherwise be written under
   the wrong name and silently bind the wrong version at runtime.
8. **Write** the map re-rendered in canonical form (4-space indent,
   trailing newline), refusing to overwrite without `--force`.

### Exact-miss fails loudly

A wrong map is worse than no map, so an unknown `(app, version_code)`
(HTTP 404) fails with an actionable message rather than falling back to a
neighbouring version.

### Sidecar transport-integrity verification

Alongside each map the rosetta-maps repo publishes a **detached
`<version_code>.json.sha256` sidecar** — the map URL plus a `.sha256`
suffix. It is a one-line, UTF-8, coreutils `sha256sum`-format file: the
lowercase 64-hex SHA-256 of the exact map bytes, two spaces, and the bare
filename:

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  30405.json
```

`pull` fetches this sidecar and checks it against the **exact raw bytes it
received** (before any canonical re-render) as early as possible — tampered
or corrupted bytes are rejected before they are ever parsed or written.

This is a **transport-integrity** tier only: it proves the bytes arrived
intact, not who published them. Publisher authenticity is the separate,
in-map [`signer_sha256`](../maps/format.md) guard checked on-device.

The policy is **opt-in-strict during rollout**:

| Sidecar state | Without `--require-sidecar` | With `--require-sidecar` |
|---|---|---|
| Present, digest matches | proceed | proceed |
| Present, digest mismatches | **fail closed** | **fail closed** |
| Present, malformed (bad hex/length) | **fail closed** | **fail closed** |
| Absent (HTTP 404) | warn on stderr, proceed | **fail closed** |

Pass `--require-sidecar` in CI / release builds so a map can never be
bundled without a verified transport-integrity digest.

> **Cross-client contract.** This sidecar format is shared across the
> Rosetta tools: the [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps)
> repo emits the `.json.sha256` sidecar, and the
> [`rosetta-xposed`](https://github.com/Xiddoc/rosetta-xposed) Gradle
> "bake a pulled map" step verifies the **same** digest the same way. The
> algorithm — first whitespace-delimited token, lowercased, matched against
> `^[0-9a-f]{64}$`, compared to the SHA-256 of the exact map bytes — is
> identical on every client.

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

### Sidecar mismatch (tampered or corrupted bytes)

```sh
$ npx rosetta pull com.example.app@30405
rosetta pull: .sha256 sidecar mismatch: the fetched map bytes do not match the published digest. Expected e3b0… but computed 1a2b…. Refusing to write tampered or corrupted bytes (fail-closed transport integrity).
```

### Missing sidecar under `--require-sidecar`

```sh
$ npx rosetta pull com.example.app@30405 --require-sidecar
rosetta pull: no .sha256 sidecar found for …/maps/com.example.app/30405.json (HTTP 404) and --require-sidecar is set: refusing to write unverified bytes. …
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
| `0` | Map fetched, sidecar-verified, validated, and written. |
| `1` | Bad arguments, exact miss (404), oversize/invalid/identity-mismatched map, **sidecar mismatch / malformed / (under `--require-sidecar`) missing sidecar**, target exists and `--force` not passed, network or filesystem error. |

## Notes

- Maps are acquired and bundled at **build time**, never on the device.
  `pull` is the thin ergonomic over the git/GitHub source of truth; a
  `git submodule` / sparse-checkout of the maps repo is the zero-tooling
  fallback.
- Validation runs as part of the pull, so a successful `pull` implies a
  passing [`rosetta validate`](validate.md).

See the [CLI overview](overview.md) for the full command list.
