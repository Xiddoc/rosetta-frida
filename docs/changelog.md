# Changelog

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

- **Schema v1** — `schema_version: 1` mandatory. Validated by Zod.
- **JSONC** — canonical on-disk format. Comments and trailing
  commas supported by in-tree stripper.
- **YAML converter** — `yamlToMap(...)` via the `yaml` package.
- **TS-module converter** — `tsModuleToMap(...)` via dynamic
  `import()`.
- **Single-map and registry forms** — `RosettaMap` and
  `RosettaMapRegistry`.
- **15-class anonymized sample map** at
  `maps/com.example.app/3.4.5.jsonc` covering AIDL stubs,
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

The `rosetta` binary, six commands:

- [`init <app> <version>`](cli/init.md) — scaffold a new JSONC map.
- [`validate <map>`](cli/validate.md) — schema + sanity check.
  Auto-detects JSONC / YAML / TS-module from extension.
- [`convert <in> -o <out>`](cli/convert.md) — YAML / TS module →
  canonical JSONC.
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
- `JsoncParseError` — JSONC source syntax error; carries `line`/`col`.
- `MapVersionMismatchError` — loaded map doesn't match detected
  app/version.
- `HealthCheckFailedError` — attach-time check failed, strict mode.
- `MarkerBlockError` — bundle has no marker block or malformed one.
- `UnresolvedAccessError` — warn-mode sentinel actually used.

### Tests

- **595 tests across 34 files.**
- **100% line / branch / function / statement coverage.**
- Test pattern: dependency-injected `Java.use` / `fs`; each
  subsystem unit-testable in isolation.

### Documentation

- Per-API docs (this site).
- Annotated sample hook at `examples/sample-hook/`.
- README at the package root.

## What's coming in V1.5

Not in V1.0; tracked for the next release:

- `rosetta diff <a.jsonc> <b.jsonc>` — show rotation deltas between
  versions.
- `rosetta merge <a.jsonc> <b.jsonc> [...]` — merge partial maps.
- `rosetta merge-bundle <bundle.js> <maps...> -o <out>` —
  single-map → registry bundle.
- `rosetta types <map.jsonc> -o <out.d.ts>` — generate per-map TS
  declarations.
- `rosetta migrate <map.jsonc>` — schema migrators (for when v2 ships).
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
