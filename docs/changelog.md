# Changelog

## 0.1.0 — 2026-06-07

First published release (npm). Packages everything described under
[V1.0 — proof of life](#v10-proof-of-life) below plus the
[Unreleased](#unreleased) hardening that landed on top of it:
on-device `signer_sha256` enforcement, the Zod map-input security
bounds, the CLI hardening (no TS/JS-module ingestion, path
containment), and the least-privilege CI workflow. Pre-1.0: the
public surface may still shift before 1.0.0.

## Unreleased

### CLI (map-authoring verbs)

- **Library-first parity for the V1.5 verbs.** The pure cores of `diff`,
  `merge`, `types`, and the semantic checks were extracted out of
  `cli/commands/*` into `src/` and re-exported from `src/index.ts`, so they
  are usable programmatically (matching `convert`): `diffMaps` /
  `renderHumanDiff` (`src/diff/`), `mergeMaps` (`src/merge/`), `verifyMap`
  (`src/verify/`), and `renderTypes` / `collectNames` (`src/types-emit/`). The
  CLI files are now thin arg-parse + IO wrappers.
- **Dropped the `merge-bundle` alias.** It was a verbatim duplicate of `merge`
  (and leaked its own name into the success line). Only `merge` remains.
- **Folded `verify` into `validate --deep`.** The standalone `verify` verb took
  the same input, output shape, and exit codes as `validate` and differed only
  by check depth, so it became a `--deep` (alias `--semantic`) flag on
  `validate`. `--json` emits the structured findings for CI. `verifyMap` stays
  exported for programmatic use.
- **`mergeMaps` now takes an options object** (`{ strict, onOverride }`) instead
  of a positional boolean. In non-strict mode each last-wins override of an
  *obfuscated* name — the "silent wrong name corrupts hooks" hazard — emits a
  `note:` line to stderr. The per-class scalar fold now strips `undefined` like
  the top-level path, so an explicit `extends: undefined` on a later input can
  no longer erase a base value.
- **`diff` gained `--exit-code`** (CI "fail if the map rotated": exit 1 on a
  non-empty diff; default stays 0). The human header now shows both maps'
  `version` labels when present, and `diffMaps` asserts both maps describe the
  same app so a direct caller cannot silently mislabel the diff.

### CLI (correctness fixes)

- **`types`: valid TypeScript for schema-legal names.** String literals are now
  rendered with `JSON.stringify` (double-quoted, fully escaped) so a
  class/method/field name containing `'` or `\` no longer emits a syntax error;
  the generated JSDoc header sanitizes a block-comment terminator out of the
  interpolated `app`/`version` so a hostile `version` cannot break out of the
  comment.
- **`validate --deep`: fewer false positives, no fail-hard on heuristics.** The
  dangling-`extends` / un-translated-arg-type heuristic now matches against the
  **full** `app` package prefix (not a 2-segment slice), eliminating
  cross-namespace false positives on real vendor apps (e.g. a
  `com.google.android.apps.*` app referencing `com.google.android.gms.*`). The
  semantic findings are classified by severity: duplicate obfuscated names per
  dex, `aidl_txn` collisions, and unparseable signatures are HARD errors (exit
  1); the heuristic cross-references are WARNINGS that are reported but never
  fail the build (`VerifyIssue` gained a `severity` field).

### Runtime

- **Expanded fuzzy version matching** (`src/session/version-match.ts`,
  `src/config.ts`; issue #22) — `versionMatch` now also accepts a richer
  object form (`VersionMatchConfig`) alongside the legacy `'exact'` /
  `'fuzzy'` strings: an opt-in numeric `versionCodeRange` over the
  authoritative `version_code`, an opt-in semver-ish `versionRange` over the
  label, a `maxDistance` ceiling that makes a too-far nearest-label pick
  **fail loudly**, and a `ranked` flag that exposes the full ranked
  candidate list. The same shape is the new typed-config default
  (`RosettaConfig.versionMatching`, validated by one shared Zod schema and
  consultable via `SessionOptions.config`). Exact `version_code` stays the
  default and highest-precedence selection; every new knob is strictly
  opt-in and a miss with fuzzy disabled still throws the same
  `no map for version '…'` error (RFC 0001 Decision 3 preserved). Moves the
  V1.5-roadmap item out of *deferred*.

  *Review follow-ups (issue #22):*
  - **`maxDistance` is now a major-dominant lexicographic ceiling**,
    consistent with the candidate ranking — a pick is accepted only when its
    distance `[Δmajor, Δminor, Δpatch]` is `<= [maxDistance, 0, 0]`. The old
    per-component check was inconsistent (it rejected `[0,0,5]` yet accepted
    `[1,0,0]` at `maxDistance: 1`). It is explicitly a **label-distance**
    ceiling: it now also gates the `versionRange` (label-range) tier, and is
    rejected at config time when paired with **only** a `versionCodeRange`
    (a no-op, since that tier ranks by a different metric).
  - **Parse-time range validation hardened**: an inverted `versionRange`
    (`min > max`, compared on the same parsed tuple as selection) and an
    all-undefined range (`{}`, which silently matched every map) are now
    rejected with a clear error instead of surfacing later as a misleading
    "no map".
  - **`map-load` now carries a `selectionKind`** (`'exact' | 'nearest' |
    'code-range' | 'label-range'`), threaded through the pick result and the
    post-pick acceptance check, so the five selection tiers stay
    distinguishable rather than collapsing to one `fuzzy` boolean — a
    deliberate (possibly far) range pick is visible to callers and events.
  - **Documented that ranges are independently opt-in**: any one of
    `strategy: 'fuzzy'`, `versionCodeRange`, or `versionRange` engages
    approximate selection on its own; a range works under `strategy:
    'exact'`/omitted by design.
  - Internal: extracted a single shared `compareTuple` / `parseVersion`
    (`src/session/version-tuple.ts`) used by both the config range
    refinements and the runtime pick, and a guarded `getMap` registry
    accessor — removing duplicate comparators and `as RosettaMap` casts.

- **On-device `signer_sha256` enforcement** (`src/session/signer-detect.ts`)
  — when the loaded map carries a `signer_sha256`, `rosetta.session(...)`
  now reads the running app's signing certificate **in-process**
  (`GET_SIGNING_CERTIFICATES` → `signingInfo.apkContentsSigners` on
  API 28+, `GET_SIGNATURES` → `packageInfo.signatures` as the pre-28
  fallback), SHA-256's each certificate, and **fails closed** with the new
  [`SignerMismatchError`](reference/errors.md#signermismatcherror) if no
  live signer matches. A match on **any** one of several signers passes
  (key-rotation lineage). The check runs after version selection and before
  the health check, emits a structured
  [`signer-check`](reference/events.md#signercheckevent) diagnostic event,
  and is gated by the new `SessionOptions.enforceSigner` knob (default
  `true`, the secure default; set `false` to opt out). When the map has no
  `signer_sha256` the check is skipped entirely. Moves the V2-roadmap item
  out of *planned*.

### Validation (security bounds)

- **Map input bounds + key safety** (`src/validate/schema.ts`) — the Zod
  validator now enforces size/cardinality caps, string `maxLength`s, an
  `app` package-name pattern, a `version_code` ceiling, an `extends`
  cap, a `signer_sha256` 64-hex pattern, and rejection of reserved keys
  (`__proto__`/`constructor`/`prototype`) — mirroring the canonical
  rosetta-maps JSON Schema so all clients agree.
- **`version_code` widened to the full 64-bit `longVersionCode`**
  (rosetta-maps#8). The cap moved from the int32 max (2^31 − 1) to
  `Number.MAX_SAFE_INTEGER` (2^53 − 1) across the schema, Zod
  (`MAX_VERSION_CODE`), and the Kotlin client. Android's `longVersionCode`
  is `(versionCodeMajor << 32) | versionCode`; apps that set
  `versionCodeMajor` exceeded the old cap and their maps were silently
  unselectable. The value is **never masked** to its low 32 bits (that
  would alias distinct releases). `src/session/auto-detect.ts` now reads
  the full `longVersionCode` and **fails loudly** instead of truncating if
  a bridge ever returns a value above 2^53 − 1. See RFC 0001 Decision 3.

### CLI security hardening

- **Removed TS/JS-module map ingestion (build-time RCE).** `rosetta
  convert` / `validate` no longer accept `.ts`/`.js`/`.mjs`/`.cjs`
  inputs. They used to be loaded via dynamic `import()`, executing
  arbitrary contributor-supplied code *before* validation. Maps are
  pure data — author them as JSON or YAML. Module inputs are now
  refused with a clear error, never imported. `tsModuleToMap` is gone;
  `convertToJson` accepts YAML only.
- **Path containment for CLI writers (arbitrary file write).** All
  commands that build an on-disk path (`init`, `convert`, `extract`,
  `patch`) now validate the `app`/`version` identity tokens and
  contain every output path to the project tree (CWD). Traversal
  (`../…`), absolute escapes, and NUL bytes are refused before any IO.
  See `src/parse/paths.ts`.

### CI / supply chain

- Least-privilege workflow permissions; the APK-building `pipeline`
  job now runs on all-branch PRs as an advisory (`continue-on-error`)
  check while the SDK-free `verify` (with `aidl:lint`) stays the
  required gate; apktool downloads and third-party actions are pinned
  by SHA-256 / commit SHA.

## V1.0 — proof of life

The first complete release. Every subsystem the strategic design
called out is implemented and tested.

### Runtime

- **Resolver** (`src/resolver/`) — real → obfuscated translation
  with a memoized per-session cache, reverse-index for type
  translation, and runtime `override(...)` support. Throws
  [`ResolveError`](reference/errors.md#resolveerror) in strict
  mode; returns a sentinel in warn mode.
- **Sentinels** (`makeSentinel`, `isSentinel`) — the `warn`-policy
  deferred-error path. Sentinels throw
  [`UnresolvedAccessError`](reference/errors.md#unresolvedaccesserror)
  when actually used.
- **Diagnostics** (`src/log.ts`, `src/diagnostics/`) — typed
  `EventBus` with `on(...)` / `onType(...)` subscription, trace
  formatter, `createSilentBus()` helper.
- **Session** (`src/session/`) — full lifecycle. Auto-detect via
  in-process `ActivityThread.currentApplication().getApplicationContext().
  getPackageManager().getPackageInfo(...)`. Registry-bundle version
  picking with optional `versionMatch: 'fuzzy'`. Attach-time health
  check with configurable threshold. Failure policies `strict` and
  `warn`. Trace mode.

### Proxy layer

- **`ClassProxy`** — wraps `Java.use(obfName)`; translates method
  and (static) field access by real name; exposes `$realName`,
  `$obfName`, `$native`, `$resolver` introspection properties;
  `$new(...)` constructs instance proxies.
- **`MethodHandle`** — `.overload(...)` with arg-type translation;
  `.implementation =` setter on the auto-picked or selected overload;
  `.overloads` array.
- **`FieldAccessor`** — `{ value: T }` shape mirroring Frida.
- **`InstanceProxy`** — wraps an instance for translated field
  access.

### Tier 1 — declarative

- **`rosetta.hook(target, impl)`** — declarative method-hook
  installation. Both string form (`'Class.method'`) and object form
  (`{ class, method, args }`) supported. Returns a `HookHandle` with
  `.detach()`.
- **`rosetta.proceed(...args)`** — call next-in-chain from inside a
  hook body. Stack-based context tracking; nested hooks work
  naturally.
- **`rosetta.field(instance, name)`** — read an instance field by
  real name.
- **`rosetta.setField(instance, name, value)`** — write an instance
  field by real name.

### Tier 2 — `Java.use`-shaped

- **`rosetta.use(realName)`** — resolve a class to a `ClassProxy`.
- **`rosetta.type(realName)`** — translate a single real type to
  obfuscated (or pass through for primitives / framework / unmapped).

### Tier 3 — escape hatches

- **`rosetta.map.resolveClass(name)`**, **`resolveMethod(class,
  name, argTypes?)`**, **`resolveField(class, name)`**.
- **`rosetta.map.override(name, entry)`** — install a runtime
  override.
- **`rosetta.map.extract()`** — return the bound `RosettaMap`.
- **`rosetta.events.on(fn)`**, **`onType(type, fn)`** — subscribe
  to diagnostic events.

### Canonical namespace

- **`rosetta`** — the single ambient namespace tying tier-1/2/3
  together. Set via `rosetta.session(...)`. The composition uses a
  module-level singleton; explicit composition still works via
  direct imports (`use`, `hook`, `createMapApi`, …).

### Map format

- **Schema v2** — `schema_version: 2` mandatory. Adds the required
  authoritative `version_code` key and the optional `signer_sha256`
  authenticity guard; drops `apk_sha256`. Validated by Zod.
- **Strict JSON** — canonical on-disk format (no comments / trailing
  commas). Comment-bearing YAML is the authoring input rendered to
  JSON via `rosetta convert`. (V1.0 also shipped a TS-module input;
  it was removed in *Unreleased* above — build-time RCE.)
- **YAML converter** — `yamlToMap(...)` via the `yaml` package.
- **Single-map and registry forms** — `RosettaMap` and
  `RosettaMapRegistry`.
- **15-class anonymized sample map** at
  `maps/com.example.app/30405.json` covering AIDL stubs,
  callbacks, overloads, fields, constructors, enums, synthetic
  Companions, anonymous inner classes.

### Marker block

- **PEM-style markers** — `-----BEGIN ROSETTA MAP-----` /
  `-----END ROSETTA MAP-----` (and `MAP REGISTRY` variant).
- **`/*! ... */` block comments** preserve through minifiers.
- **`emitMarkerBlock`**, **`emitMarkerRegistry`**,
  **`parseMarkerBlock`**, **`patchMarkerBlock`** — full
  programmatic API.
- **`MARKER_REGEX`** exported for downstream regex tooling.
- **V2+ placeholder form** reserved in the spec (not implemented).

### CLI

The `rosetta` binary, seven commands:

- [`init <app> <version> --version-code <n>`](cli/init.md) — scaffold a
  new JSON map (the `--version-code` is required and becomes the
  filename).
- [`pull <app>@<version_code>`](cli/pull.md) — fetch + schema-validate +
  identity-cross-check the verified map for an `(app, version_code)`
  from the community
  [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo and
  write it into the project. Build-time only — never fetched on the
  device.
- [`validate <map>`](cli/validate.md) — schema + sanity check.
  Auto-detects JSON / YAML from extension.
- [`convert <in> -o <out>`](cli/convert.md) — YAML → canonical JSON.
- [`patch <bundle.js> --map <new>`](cli/patch.md) — replace embedded
  map in a compiled bundle. In-place by default.
- [`extract <bundle.js> -o <out>`](cli/extract.md) — pull the
  embedded map back out.
- [`inspect <bundle.js>`](cli/inspect.md) — one-line summary of
  embedded map.

### Error hierarchy

Nine error classes, all subclasses of [`RosettaError`](reference/errors.md#rosettaerror):

- `ResolveError` — class/method/field not in map.
- `AmbiguousOverloadError` — multi-overload method, string form.
- `MapValidationError` — schema failure; carries structured `issues`.
- `JsonParseError` — JSON source syntax error; carries `line`/`col`.
- `MapVersionMismatchError` — loaded map doesn't match detected
  app/version.
- `HealthCheckFailedError` — attach-time check failed, strict mode.
- `MarkerBlockError` — bundle has no marker block or malformed one.
- `UnresolvedAccessError` — warn-mode sentinel actually used.

### Tests

- **100% line / branch / function / statement coverage** (the gate excludes barrels / pure type declarations / the CLI entry shim; see the repository's CI for the current test count).
- Test pattern: dependency-injected `Java.use` / `fs`; each
  subsystem unit-testable in isolation.

### Documentation

- Per-API docs (this site).
- Annotated sample hook at `examples/sample-hook/`.
- README at the package root.

## What's coming in V1.5

Not in V1.0; tracked for the next release:

- `rosetta diff <a.json> <b.json>` — show rotation deltas between
  versions.
- `rosetta merge <a.json> <b.json> [...]` — merge partial maps.
- `rosetta merge-bundle <bundle.js> <maps...> -o <out>` —
  single-map → registry bundle.
- `rosetta types <map.json> -o <out.d.ts>` — generate per-map TS
  declarations.
- `rosetta migrate <map.json>` — schema migrators (e.g. for a future v3 bump; the 1→2 change was a hard cutover).
- `rosetta verify --device <id>` — live health check via
  `frida-server`.
- `frida-compile` plugin for auto-marker-wrapping.
- Multi-session support on the `rosetta` namespace.

## What's coming in V2

- Public maps repo (`rosetta-frida-maps`) — community-contributed
  obfuscation maps validated by CI.
- Runtime injection (`rosetta.injectMap(...)`) — populate the marker
  block's V2 placeholder form at attach time.
- Self-healing discovery — strategy registry that runs when the map
  misses. Includes AIDL-descriptor matching, signature scan in known
  class, superclass match, stable-string anchor.

## What's coming in V3

- Native (JNI / ELF symbol) mapping.
- Non-Frida runtimes (Xposed, ART, Riru, Zygisk).
- AI-assisted mapping generation.
- Hosted resolution service.
- IDE plugin (VSCode hints for obfuscated-name overlays, map
  coverage warnings, go-to-definition in jadx output).
