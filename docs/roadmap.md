# Roadmap

This is the forward-looking plan for rosetta-frida: what's next, **why
each item matters (purpose)**, and **what it buys us (benefit)**. It is
the companion to [`changelog.md`](changelog.md) (what already shipped)
and [`reference/design.md`](reference/design.md) (how the current
architecture is shaped).

Each item lists:

- **Purpose** — what the task does and the problem it targets.
- **Benefit** — the concrete payoff once it lands.
- **Scope / dependencies** — rough shape of the work and what it needs
  first.
- **Status** — `planned`, `in progress`, or `blocked`.

Milestones are ordered by priority, not by strict release boundaries —
the V1.5 / V2 / V3 grouping mirrors `changelog.md` but several items can
move between them as priorities shift.

## Milestones at a glance

| Version        | Focus                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.0 (current) | Java-only Frida runtime + CLI. Maps ship in-repo.                                                                                                                                           |
| V1.5           | `rosetta diff` / `merge` / `types` / `verify` CLI commands. Multi-version registry bundles. Fuzzy version matching.                                                                         |
| V2             | Self-healing runtime discovery. Public [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) community repo (canonical schema owner; scaffolded). Frida-compile plugin for transparent marker-block injection. |
| V3             | Native (JNI / ELF) symbol mapping. Non-Frida runtimes — [`rosetta-xposed`](https://github.com/Xiddoc/rosetta-xposed) (Xposed / LSPosed / LSPatch, scaffolded). Hosted resolution service.   |

---

## Housekeeping (do first)

### Fix the test-app integration pipeline (`pipeline.yml`) and get it green

- **Purpose.** The `pipeline.yml` GitHub Actions job builds both
  test-app APKs, runs them through sigmatcher → the adapter, and diffs
  the emitted map against the committed goldens
  (`tests/fixtures/test-app/expected/v1.0.0.json` / `v1.1.0.json`). It
  is **currently failing — and appears to have never been green.**
- **Root cause (confirmed).** The AIDL fixture
  `tests/fixtures/test-app/app/src/main/aidl/com/example/testapp/IRemoteService.aidl`
  declares `requestTicket` **twice** ("to exercise the multi-overload
  form"). AIDL does **not** support method overloading — interface
  methods must have unique names — so `:app:compileReleaseAidl` fails and
  the APK never builds. Pre-existing since the fixture's founding commit
  (`6ebd5a6`); the schema-v2 work was simply the first change to touch
  this job's trigger paths and make it run.
- **Why it matters.** This is the only check that exercises the **real
  sigmatcher output ordering** end-to-end; the unit suite can't. Until
  it's green, the goldens and the adapter's class/method emission order
  are unverified against a real sigmatcher run (the goldens are
  hand-authored today and almost certainly do *not* byte-match a real
  build).
- **Suggested fix.**
  1. **Remove the same-name AIDL overload** — AIDL cannot express it.
     The multi-overload schema feature is *already* exercised by
     `BlobCache.put` (a plain class with `put_2arg` / `put_3arg` in the
     `methodNameMap`), so the AIDL doesn't need to. Make `IRemoteService`
     declare a single `requestTicket` (plus `requestPrompt`) and fix the
     now-misleading header comment. Check the Java sources, the
     `proguard-rules`/applymapping seeds, and `signatures/test-app.yaml`
     for references to the dropped overload.
  2. **Regenerate the goldens** with
     `tests/fixtures/test-app/regenerate-goldens.sh` (it now passes
     `--version-code`) against a real build, and commit them — the
     hand-authored goldens won't byte-match a fresh sigmatcher run.
  3. Confirm `pipeline.yml` is green; the first error likely masks
     others, so iterate against a real build rather than fixing blind.
- **Scope / dependencies.** **Requires the Android SDK + sigmatcher**,
  which the default web environment's network policy blocks
  (`dl.google.com` / `maven.google.com` return 403 while PyPI/GitHub are
  reachable). Do this in a session/environment where those hosts are
  allowlisted (or against CI).
- **Status.** blocked (needs the Android SDK reachable); high priority
  once unblocked.

---

## Deferred follow-ups from the schema-v2 change

These close out the app-identity work that landed the `version_code` and
`signer_sha256` fields.

### On-device `signer_sha256` enforcement

- **Purpose.** The schema carries an optional `signer_sha256` (the hash
  of the APK signing certificate), but nothing reads it at runtime yet.
  Wire the session attach path to read the running app's signing
  certificate (via `PackageManager` signing info), hash it, and compare
  it against `map.signer_sha256` when the field is present.
- **Benefit.** Turns the field from documentation into a real trust
  gate: a map cannot be silently applied to a **repackaged or spoofed**
  build that happens to share the same `version_code`. This is the
  authenticity half of the "right map for the right app" guarantee.
- **Scope / dependencies.** Extend `src/session/auto-detect.ts` (or a
  sibling) to read signing certs; add a comparison step + a new failure
  mode in `src/session/session.ts`; surface a `Config`/`SessionOptions`
  opt-out (`verifySigner?: boolean`, default on when the field is
  present). New error type or reuse `MapVersionMismatchError`'s sibling.
  Needs Frida-mock support for the signing API.
- **Status.** planned. The field, adapter option, and sample data
  already shipped; only the runtime guard remains.

### `rosetta migrate` + schema migrators

- **Purpose.** The `1 → 2` bump was a hard cutover — schema-1 maps are
  rejected outright (`z.literal(2)`). Add an in-tree migrator chain and a
  `rosetta migrate <map>` command that upgrades older maps to the
  current schema.
- **Benefit.** Future schema bumps stop being breaking changes.
  Community-contributed maps and pinned bundles keep loading after a
  bump instead of failing hard, which is essential once the public maps
  repo exists.
- **Scope / dependencies.** A registry of `(from, to)` migrator
  functions; a CLI command; a `--in-place`/`-o` flag. Best paired with
  the next schema bump so there's a concrete `1 → 2`/`2 → 3` migrator to
  validate against. (`changelog.md` lists this under V1.5.)
- **Status.** planned.

---

## Broader arc — cross-framework

### A second framework binding (Xposed / LSPosed)

- **Purpose.** The system is structured as four layers (signature
  authoring, canonical map artifact, resolution semantics, runtime
  binding) where only the bottom layer is Frida-specific. Build a
  **second binding** that applies resolved names through the Xposed /
  LSPosed API instead of `Java.use`.
- **Benefit.** Proves the artifact + resolution layers are genuinely
  framework-neutral (not accidentally Frida-shaped), and unlocks the
  large Xposed-module audience reusing the **exact same maps**. The maps
  repo then serves both ecosystems from one source of truth.
- **Scope / dependencies.** A new binding package mirroring
  `src/proxy/` against the Xposed hooking API; the resolver and map
  layers are reused unchanged. Largest item here; a V2/V3-scale effort.
- **Status.** in progress — **scaffolded at
  [`Xiddoc/rosetta-xposed`](https://github.com/Xiddoc/rosetta-xposed)**.
  The neutral core (a Kotlin twin of the map model + resolver, kept honest
  by a shared conformance suite) and the static layer-4 binding (resolve
  real → obf → a `java.lang.reflect.Member` handed to the developer's hook
  API) are built and JVM-tested. Remaining: the DexKit dynamic /
  self-healing backend, deferred binding for late-loaded dex, and
  `signer_sha256` enforcement.

---

## Developer experience & tech debt

### Centralize `schema_version` / `version_code` in test fixtures

- **Purpose.** The schema version is now DRY in the source code (one
  `CURRENT_SCHEMA_VERSION` constant) and guarded in docs + the sample map
  (`npm run schema-version:check`). The remaining hand-maintained surface
  is the **test suite**: ~30 test files inline `schema_version: 2` (and
  `version_code: 1`) in map literals.
- **Why it wasn't auto-fixed.** A blind codemod over the tests is unsafe
  because the suite deliberately mixes two kinds of literal: **valid**
  maps that *should* track the current version, and **invalid** maps that
  intentionally pin an old/wrong version for rejection tests (e.g.
  `schema_version: 1` "is rejected", `99` "is invalid", "expected 2").
  A find-replace can't tell them apart and would corrupt the negative
  tests.
- **Suggested approach.** Introduce a shared test map factory — e.g.
  `tests/helpers/maps.ts` exporting `validMap(overrides?:
  Partial<RosettaMap>): RosettaMap` — that defaults `schema_version:
  CURRENT_SCHEMA_VERSION`, a `version_code`, `app`, `version`, and an
  empty `classes`, merged with per-test overrides. Migrate the **valid**
  fixtures across the suite to it (or, more minimally, just import
  `CURRENT_SCHEMA_VERSION` for the `schema_version` field). Leave the
  negative-test literals explicit and clearly flagged (e.g. a
  `// schema-keep: intentional old version` comment).
- **Benefit.** A future schema bump then touches **one** constant and the
  valid fixtures follow automatically — eliminating the last big manual
  surface. As a bonus, a factory de-duplicates fixture boilerplate
  (`version_code`, `app`, `classes`) and makes test intent clearer
  (factory + overrides instead of copy-pasted literals).
- **Scope / care.** Broad but mechanical (~30 files). Do it as its **own
  PR** so the diff is reviewable; keep the 100% coverage gate; don't fold
  it into a feature change. Verify the negative tests still assert
  rejection with explicit literals afterward. (Optionally extend
  `scripts/check-schema-version.mjs` to assert no stray *valid*-looking
  `schema_version` literal remains in `tests/`, but once fixtures use the
  factory there's little left to guard.)
- **Status.** planned (deliberately deferred from the schema-version-DRY
  change because it's invasive enough to deserve its own review).

### Rename the inner `*Map` Record aliases (reserve "map" for the artifact)

- **Purpose.** "Map" is used in two senses in `src/types/map.ts`: the
  **translation artifact** (`RosettaMap`, one `(app, version_code)`; and
  `RosettaMapRegistry`, a record of them) versus plain **lookup
  dictionaries** (`ClassMap = Record<realFQN, ClassEntry>`, `MethodMap`,
  `FieldMap`). Rename the dictionary aliases to `*Table` (or `*Index`) —
  e.g. `ClassMap → ClassTable`, `MethodMap → MethodTable`, `FieldMap →
  FieldTable` — and keep `RosettaMap` / `RosettaMapRegistry` as-is.
- **Benefit.** "Map" then means exactly one thing (the Rosetta artifact),
  matching the `rosetta-maps` repo name; the dictionaries read as
  lookups. New contributors stop conflating "the map" with "a Record".
- **Scope / care.** Mechanical rename across `src/`, tests, and docs.
  Note these aliases are part of the **public type surface** (re-exported
  from `src/types/index.ts`), so it's a breaking type-name change — ship
  it behind deprecated re-exports (`export type ClassMap = ClassTable`)
  or fold it into the next breaking release. Keep the 100% coverage gate;
  do it as its own PR. Low urgency — clarity, not correctness.
- **Status.** planned.

### Reconcile provenance counts (`MapSource.classes` vs per-class `source`)

- **Purpose.** Each class is already attributed to a tool via
  `ClassEntry.source` (e.g. `"sigmatcher"`), so "which classes came from
  which tool" is answerable from the data. The top-level
  `MapSource.classes` count duplicates that — it's a hand-maintained
  rollup that can drift out of sync with the per-class tags, and nothing
  validates the two agree.
- **Benefit.** A single source of truth for provenance. No stale or
  contradictory counts; the authoritative per-class `source` answers the
  "which ones?" question precisely, and tooling derives the totals.
- **Options / scope.** Either (a) **derive** the count on demand
  (compute it in `inspect` / a provenance report) and drop the stored
  field on the next schema bump; or (b) keep the field but add a
  `validate`-time check/warning that it equals the per-class tally.
  Recommend (b) now (non-breaking — `classes` is already optional), (a)
  at the next bump. Either way, keep `sources[]` for the per-*tool*
  metadata that has nowhere else to live (`config`, `notes`,
  `confidence`).
- **Status.** planned.

---

## V1.5 — tooling for map maintainers

The theme: make authoring, maintaining, and shipping maps fast. These
are CLI/tooling additions on top of the stable V1 runtime.

### `rosetta diff <a.json> <b.json>`

- **Purpose.** Show the real → obfuscated **rotation deltas** between two
  versions' maps: which classes/methods/fields changed obfuscated names,
  which were added/removed.
- **Benefit.** Turns "what rotated this release?" from a manual jadx +
  hand-diff session into a single command — directly attacking the core
  pain that motivated the whole project.
- **Scope / dependencies.** Pure data operation over two validated
  `RosettaMap`s; structured + human-readable output. No runtime
  dependency.
- **Status.** planned.

### `rosetta merge <a.json> <b.json> [...]`

- **Purpose.** Combine partial maps from different sources (sigmatcher
  output + hand-authored corrections + runtime-discovered entries) into
  one map, with a defined precedence/conflict policy.
- **Benefit.** Lets multiple sources and contributors compose a map
  without hand-merging JSON, and matches the multi-`sources` provenance
  model the schema already supports.
- **Scope / dependencies.** Merge strategy + conflict reporting; reuses
  the validator. Pairs naturally with `diff`.
- **Status.** planned.

### `rosetta merge-bundle <bundle.js> <maps...> -o <out>`

- **Purpose.** Fold several single-version maps into one
  `RosettaMapRegistry` embedded as a single marker block in a compiled
  bundle.
- **Benefit.** One compiled hook ships support for many app versions —
  the "write once, hook many versions" promise realized at the
  distribution layer. The runtime already selects the right entry by
  `version_code`.
- **Scope / dependencies.** Builds on the existing marker emit/patch
  code (`src/marker/`); needs registry assembly + dedupe.
- **Status.** planned.

### `rosetta types <map.json> -o <out.d.ts>`

- **Purpose.** Generate per-map TypeScript declarations for the real
  class/method/field names a map covers.
- **Benefit.** Compile-time autocomplete and typo-catching on names in
  hook source, so a misspelled real name fails at `tsc` time instead of
  becoming a silent runtime resolution miss.
- **Scope / dependencies.** A `.d.ts` emitter over a validated map.
  Standalone.
- **Status.** planned.

### `rosetta verify --device <id>`

- **Purpose.** Run the attach-time health check **live** against
  `frida-server` on a connected device, outside of a full hook script.
- **Benefit.** A CI / pre-flight answer to "does this map still resolve
  against the real app on a device?" without writing or running a hook —
  catches a stale map before it ships.
- **Scope / dependencies.** Reuses `src/session/health-check.ts`; adds a
  device-connection driver (the first piece of tooling that talks to a
  live `frida-server` rather than running in-process).
- **Status.** planned.

### `frida-compile` plugin for auto-marker-wrapping

- **Purpose.** Embed the marker block automatically at compile time
  instead of the current manual "emit marker + concat" build step
  (documented in `examples/sample-hook/README.md`).
- **Benefit.** `inspect` / `extract` / `patch` work on **every** compiled
  bundle by default, removing a manual build step and its footguns.
- **Scope / dependencies.** A `frida-compile` plugin hook that calls
  `emitMarkerBlock`/`emitMarkerRegistry` on the imported map. Depends on
  `frida-compile`'s plugin API surface.
- **Status.** planned.

### Multi-session support on the `rosetta` namespace

- **Purpose.** Today `rosetta.session(...)` sets a single module-level
  ambient session. Allow more than one active session (e.g. several
  processes/apps) without juggling explicit imports.
- **Benefit.** Unblocks fleet / multi-target orchestration; lets one
  script drive hooks against multiple apps or versions concurrently.
- **Scope / dependencies.** Rework the ambient singleton in
  `src/api/rosetta.ts` into a session-scoped handle while keeping the
  ergonomic single-session default. Touches the tier-1/2/3 composition.
- **Status.** planned.

---

## V2 — the distribution flywheel

The theme: turn rosetta-frida from a library into an ecosystem.

### Public `rosetta-maps` repository

- **Purpose.** A separate, community-contributed repository of map
  files, PR-gated by automated schema validation (no code review), keyed
  by `(app, version_code)` with the `signer_sha256` authenticity guard.
  At **build time**, a developer pulls the map for the version they want
  to support and bundles it into their script — the device never fetches
  a map from the cloud.
- **Benefit.** **The killer feature.** A hook works against a version its
  author never tested, because someone else contributed that version's
  map — an obfuscation-map "CVE database." Schema v2 was deliberately
  shaped (authoritative `version_code` key, signer guard) to make this
  selection and trust model sound.
- **Scope / dependencies.** A new repo with CI validation using this
  library's validator; a build-time `rosetta pull` verb that fetches a
  single verified map into the developer's project (no device-side
  client); a contribution + provenance workflow. Depends on
  `signer_sha256` enforcement and `migrate` for long-term map
  durability.
- **Status.** in progress — **scaffolded at
  [`Xiddoc/rosetta-maps`](https://github.com/Xiddoc/rosetta-maps)**. The
  repo layout (`signatures/` source-of-truth + `maps/<app>/<version_code>.json`
  artifacts), the structural validation CI (reusing this library's
  `rosetta validate`, no APK hosted), the filename↔`version_code`
  convention check, a JSON-Schema editor aid, and a worked example are in
  place. Remaining: the build-time `rosetta pull` verb here, plus the
  attestation / trusted-runner / device-telemetry trust tiers there.

### Runtime map injection

- **Purpose.** Populate the marker block's reserved placeholder form
  (`let __rosetta_map = null;`) at attach time via
  `rosetta.injectMap(...)`, rather than only at compile time.
- **Benefit.** Hot-swap a map without recompiling the bundle — the map
  is supplied by the controlling Frida host (on the developer's machine),
  not fetched by the device. The mechanism behind fleet-management
  workflows where the host pushes an updated map into a live session.
- **Scope / dependencies.** The marker-block placeholder seam already
  exists in the spec; needs the injection API + lifecycle handling
  (re-binding the resolver mid-session). Pairs with the maps repo.
- **Status.** planned.

### Self-healing discovery

- **Purpose.** When a lookup misses, run runtime discovery strategies to
  find the right name anyway: AIDL-descriptor matching, signature scan
  within a known class, superclass matching, and stable-string anchors.
  The resolver's lookup chain already reserves the slot for this (see
  `reference/design.md`, "Lookup chain").
- **Benefit.** Hooks survive a rotation **before** anyone publishes an
  updated map — the runtime degrades gracefully instead of failing. This
  is the long-term robustness story and the reason the schema carries
  `kind`, `aidl_descriptor`, and `anchors` metadata today.
- **Scope / dependencies.** A pluggable strategy registry invoked at the
  resolver's failure slot; needs the metadata the schema already
  captures plus runtime class enumeration. Largest V2 runtime item.
- **Status.** planned.

---

## V3 — frontier

Longer-horizon items from `changelog.md`, captured here for continuity:

- **Native (JNI / ELF symbol) mapping** — extend the model below the
  Java layer to native function pointers / demangled symbols / base
  offsets. A different mapping shape; deliberately out of V1/V2 scope.
- **Non-Frida runtimes** (Xposed, ART, Riru, Zygisk) — the binding-layer
  generalization above, taken to its conclusion.
- **AI-assisted mapping generation** — propose map entries from static
  analysis + diffs.
- **Hosted resolution service** — resolve names as a service rather than
  a bundled artifact.
- **IDE plugin** — obfuscated-name overlays, map-coverage warnings, and
  go-to-definition against jadx output.

---

## Maintaining this file

When you finish an item, move its essence to `changelog.md` (what
shipped) and delete it here, or mark it `done` with a one-line pointer.
Keep purpose/benefit framing on new items so the next contributor can
tell *why* something is on the list, not just *what* it is.
