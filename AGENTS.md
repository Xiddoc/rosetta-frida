# AGENTS.md — rosetta-frida

## What this project is

A library that lets you write Frida hooks against **real (unobfuscated)
class and method names**, with a translation layer that resolves them
to the obfuscated names that actually exist at runtime in the target
app. The translation tables are **per-app, per-version** JSON maps
(`schema_version: 3`) that the library loads at attach time.

Write once, hook many versions.

## Testing mandate

We strive for maximum coverage: **everything that can be tested must be
tested.** Keep the `npm run verify` 100% coverage gate green, and
add/extend co-located tests with every change. Use the Frida mock under
`tests/mocks/` for anything that touches the Java bridge.

## Why this project exists

The pain point that motivated it, from real experience reverse-engineering
large obfuscated Android apps:

- Large commercial Android apps **rotate obfuscation every minor
  release.** Class anchors that work for app version `1.2.x` don't
  survive `1.3.x`. We've observed renames like `aaaa → aaab`,
  `bbbb → bbcc`, `cccc → ccdd`, `dd → de`, etc., between two adjacent
  point releases. The hooked methods themselves often stayed at single
  letters like `c`/`e`/`f` — but the **classes** they live on got
  reassigned. We've seen the same pattern on multiple apps: an
  obfuscated name (say `eeee`) that referred to a key service-client
  class in version 2.16.x became an unrelated class (e.g. a `Runnable`
  or a `dagger.internal.Provider`) by version 2.15.x, with the
  original role moving to a fresh letter combination.
- Every release-rotation forced:
    1. A new static-analysis pass (jadx + diff against previous version)
       to discover the new obfuscated names.
    2. A patch to every Frida script that hard-codes those names.
    3. A re-compile of every bundle.
    4. A re-test on the device.
- We _partially_ mitigated this in past projects by writing
  **adaptive Frida hooks** that discover the right methods at runtime
  by _signature_ (e.g. "find the method on `aaaa` whose signature is
  `(Bundle, IInterface) → void`"). That works when the class name is
  stable but the method name moved — but it fails when the class name
  itself rotates (because we don't know where to _start_ the
  signature search). It also doesn't help anyone _reading_ the hook
  later, since the JS source still says `aaaa` and `cccc`, which mean
  nothing to a reader who's looking at a different release than the
  hook author was.
- The right shape is to **decouple "what we want to hook" (real name)
  from "how it's spelled today" (obfuscated name)** by introducing
  per-version mapping files and a lookup layer that consults them.

## Form factor — standalone npm package

**Decided:**

- Not a Frida-core PR. Frida deliberately stays at the
  `Java.use` / `Interceptor.attach` layer. Class-name-mapping is
  app-specific, opinionated, and a layer above what Frida should
  care about. Upstream would reject it (and they'd be right to).
- Not a sigmatcher PR. Sigmatcher _produces_ obfuscation maps from
  static analysis; this tool _consumes_ them. Different concerns,
  different upstream/downstream positions. Clean split: sigmatcher
  (and other tools) emit a canonical mapping file format; this tool
  reads that format. That way sigmatcher stays focused and rosetta-
  frida can take inputs from any mapper (sigmatcher, hand-authored, and
  runtime-discovered entries all merge into the same format).
- **Standalone npm package.** Frida hooks are JS. `frida-compile`
  and `frida-java-bridge` are already established tooling. Same
  distribution channel makes sense.

## API design — runtime wrapper (not codegen)

**Decided:**

There were two candidate architectures:

| Approach                                                                                                                               | Pros                                                                                       | Cons                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **(A) Codegen** — preprocess hook source to substitute real names with obfuscated names ahead of time; output is a normal Frida script | Zero runtime overhead; output is debuggable Frida JS                                       | Per-version build artifacts; can't switch mappings at runtime; loses the "same hook works for any version" property |
| **(B) Runtime wrapper** — `m.use(realName)` proxies to `Java.use(obfName)`; mapping loaded at attach time                              | One hook script works across versions; auto-detection possible; mapping can be hot-swapped | Slightly slower startup; dynamic proxy = more failure modes to surface                                              |

**Decision: (B) runtime wrapper.** The killer feature is "same hook
script works against any version that has a mapping file." Worth the
small runtime cost.

### Shipped API

The V1 surface is `rosetta.session(...)` + a three-tier hook API, not
the early `Rosetta.attach()` sketch. The core idea is unchanged: you
reference **real** names and a proxy re-resolves them through the
loaded map at runtime.

```ts
import { rosetta } from 'rosetta-frida';
import map from './maps/com.example.app/30405.json' with { type: 'json' };

Java.perform(() => {
    // Open a session: auto-detect app + version, validate against the
    // map, run an attach-time health check.
    rosetta.session({ map });

    // Tier 1 — declarative hook by real name.
    rosetta.hook('com.example.app.IRemoteService$Stub.requestTicket', function (bundle, callback) {
        console.log('request keys:', bundle.keySet());
        return rosetta.proceed(bundle, callback);
    });

    // Tier 2 — Java.use-shaped proxy that translates names.
    const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
    // Tier 3 — raw map queries / events: rosetta.map, rosetta.events.
});
```

Behind the scenes the proxy looks up `IRemoteService$Stub` → obfuscated
`aaaa`, resolves the method `requestTicket` → `c`, and translates
real-name overload argument types (e.g. `IServiceCallback` → `bbbb`)
the same way. See `docs/api/` for the full surface.

## Mapping file format

**Schema ownership (inverted):** the canonical, language-neutral map
schema now lives in the separate
[`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) repo
(`schema/rosetta-map.schema.json` — the source of truth for the
`schema_version: 3` format). rosetta-frida is the **first-class
client** of that schema: its Zod validator (`src/validate/schema.ts`)
_tracks_ the canonical schema rather than defining it.
`rosetta-xposed` (Kotlin) is the other client. (There is no cross-repo
or git-URL dependency yet — that waits for an npm phase; the Zod
validator simply mirrors the canonical shape.)

**Resolved (post-RFC-0001):** the canonical on-disk artifact is
**strict JSON** (`schema_version: 3`), one file per
`(app, version_code)`, stored under a maps directory loaded at attach
time. YAML and TS modules remain _authoring inputs_ converted to JSON
via `rosetta convert` — the YAML below is shown for authoring
flavour. Two app-identity changes landed with schema 2:

- **`version_code` is required and authoritative.** It is the full Android
  `longVersionCode` (`(versionCodeMajor << 32) | versionCode`), never masked,
  and is the primary, O(1) key the runtime selects maps by. The `version`
  (versionName) string is a human label / fuzzy fallback only.
- **`signer_sha256`** (optional) replaced `apk_sha256`: it is the hash
  of the signing certificate, a cheap on-device authenticity guard
  (the APK-bytes hash never belonged in a per-version selection key).

```yaml
# authoring source — rosetta convert renders this to 30405.json
app: com.example.app
version: '3.4.5'
version_code: 30405
captured_at: 2026-05-11
sources:
    - tool: sigmatcher
      config: signatures/app.yaml
      classes: 47
    - tool: hand-authored
      classes: 12
      notes: 'cccc.v signature confirmed via Frida runtime trace, see commit <hash>'
    - tool: rosetta-runtime-discovered
      classes: 3
      notes: 'stub_candidate scan emitted these names at attach'

classes:
    com.example.app.service.IRemoteService$Stub:
        obfuscated: aaaa
        extends: zzzz
        dex: classes6.dex
        methods:
            requestTicket:
                obfuscated: c
                signature: '(Landroid/os/Bundle;Lbbbb;)V'
                aidl_txn: 2
            requestPrompt:
                obfuscated: f
                signature: '(Landroid/os/Bundle;Lbbbc;)V'
                aidl_txn: 3
        fields: {}

    IServiceCallback: # interface, resolves a type alias
        obfuscated: bbbb
        kind: aidl_callback
```

Why YAML/TS _for authoring_ (the canonical artifact is still strict
JSON):

- Human-readable and human-writable (a lot of these will be hand-
  authored or hand-edited).
- Comments are first-class (`# notes here`) in the authoring source.
- Multi-line strings work naturally.

The on-disk _artifact_ is strict JSON (no comments) so it imports
natively into any bundler / `frida-compile` and round-trips through
`JSON.parse` without a custom parser. Keep comment-bearing notes in a
YAML/TS authoring source and re-render with `rosetta convert`.

## Distribution model — separate maps repo

**The long-term killer feature:** a public, community-contributed
repository of mapping files. Like an obfuscation-map "CVE database."
Someone writes a hook for an app; at **build time** they pull the
community-contributed map for the version they want to support and
bundle it into their script, and the hook works — even if the original
hook author never tested against that exact version.

Two repos at maturity:

- **`rosetta-frida/`** (this repo) — library + bridge code.
- **[`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps)** (separate
  repo, **scaffolded**) — **owns the canonical, language-neutral map
  schema** (`schema/rosetta-map.schema.json`, the source of truth for the
  `schema_version: 3` format) plus contributed maps and the sigmatcher
  signatures they're generated from. PR-gated by automated schema
  validation (which reuses this repo's `rosetta validate`, whose Zod
  schema tracks the canonical one); no code review required. Each PR
  adds or updates a single `maps/<app>/<version_code>.json` (authored in
  YAML/TS, rendered via `rosetta convert`). rosetta-frida is the
  first-class **client** of that schema, not its home.

**Maps are acquired and bundled at build/author time — never fetched
from the cloud on the device.** The map for a given `(app,
version_code)` is baked into the compiled Frida script (via
`frida-compile`) or the Xposed/LSPosed APK (via Gradle) before it ever
reaches a phone; the device only sees a map that already lives inside
the shipped artifact, and does no network I/O to obtain one. The
distribution channel is therefore a **build-time, developer-machine**
concern: straight git/GitHub is the channel (it is already the source
of truth), with the `rosetta` CLI as the thin ergonomic on top — pull
the single verified map you intend to bundle into your project instead
of vendoring the whole corpus. A `git submodule` / sparse-checkout of
the maps repo is the zero-tooling fallback.

**Not in V1.** For the MVP, maps live in the same repo
(`rosetta-frida/maps/`) and ship with the library. The community maps
repo and a `rosetta pull` CLI verb are later phases — but in all of
them the fetch happens on the developer's machine at build time, not
on the device.

## Resolved design decisions

These were open questions at project start; all are now settled and
shipped in V1.0. Kept here so future sessions understand the
trade-offs behind each choice rather than re-litigating them.

### 1. Project naming

**`rosetta-frida`** (translation metaphor). Alternatives considered
and dropped: `frida-decode`, `unrot`/`unrotate`, `obf-bridge`.

### 2. Native (libffi / C symbols) coverage?

**Java-only in V1; native deferred to V2+.** Java-side rotation is the
dominant pain, and native is a different mapping shape (function
pointers, demangled symbols, base offsets) that would complicate the
file format. Shipped Java-only.

### 3. Fuzzy-version matching?

**Fail hard by default; opt-in fuzzy via config.** `version_code` is
the authoritative O(1) selection key; a wrong-version map silently
corrupts hooks, so an exact miss should fail loudly rather than fall
back unless the user explicitly allows it.

### 4. MVP scope

Shipped V1.0 went past the original weekend prototype: a three-tier
hook API (`rosetta.hook`, `rosetta.use`, `rosetta.map`) over
`rosetta.session(...)`, in-process auto-detect, attach-time health
check, a full CLI (`init`, `validate`, `convert`, `patch`, `extract`,
`inspect`), a 15-class sample map, and a sample hook — at 100%
coverage (see CI badge for current test count).

### 5. TypeScript vs plain JS?

**TypeScript source → JS output**, same pattern as
`frida-java-bridge` / `frida-il2cpp-bridge`. The map types, session
bridge, and `rosetta.use` proxy all benefit from types. Locked
contracts live under `src/types/`.

### 6. How `rosetta.session()` detects the live app version

**In-process via `PackageManager.getPackageInfo`** (reads package +
`versionCode`/`longVersionCode` from inside the target process; no
ADB dependency). The detected `version_code` is matched against the
map's authoritative `version_code` key.

### 7. Versioning the mapping file format itself

Current schema is **`3`**. Schema 2 (the RFC-0001 app-identity refinement)
made `version_code` required, added the optional `signer_sha256` guard, and
dropped `apk_sha256`; schema 3 then removed `confidence`, tightened
`captured_at` to an ISO date, let `signer_sha256` be a match-any array, and
added the optional `generated_from` / `status` / `superseded_by` fields. The
literal is a hard gate (`z.literal(3)`); `schema_version: 1` and `2` maps are
rejected and must be re-emitted at version `3`.

## When to NOT use rosetta-frida (anti-scope)

These are explicit anti-features — things rosetta-frida should not try
to do, at least in V1, so the new Claude session doesn't accidentally
scope-creep:

- **Not a deobfuscator.** It does not analyze APKs and _produce_
  mappings. It only _consumes_ them. Use sigmatcher (or jadx + manual
  work) to produce maps.
- **Not a Frida wrapper for non-Java targets.** V1 is Java/Kotlin
  Android apps only. iOS / desktop / Linux targets are out of scope.
- **Not a hook framework.** It doesn't define what a "hook" is. It
  just makes `Java.use` smarter. Users still write `.implementation =
function() { ... }`.
- **Not a sigmatcher replacement.** It does not duplicate sigmatcher's
  signature-matching logic. Sigmatcher is one upstream input among
  several.

## Orientation for a fresh session

V1.0 is built (Java-only runtime + CLI, 100% coverage — see CI badge for current test count).
The design decisions above are settled; the next frontier is the V1.5 /
V2 roadmap (`docs/reference/design.md`). When picking up work here:

1. **Read this AGENTS.md end-to-end** for the design rationale, then
   skim `docs/` (the human-facing entry point; `README.md` is the
   GitHub front page).
2. **Honour the locked type contracts in `src/types/`** — downstream
   code depends on those shapes; sketch the contract first when adding
   a subsystem.
3. **Keep maps strict JSON, `schema_version: 3`, with a `version_code`.**
   YAML/TS are authoring inputs converted via `rosetta convert`.
4. **Maintain the 100% coverage gate** (`npm run verify`); co-locate
   tests with source and use the Frida mock under `tests/mocks/`.

## Memory

Configuration in this project (map paths, fetch URLs, log levels,
etc.) should flow through a **typed config object**, not `process.env`
lookups sprinkled around. For a TypeScript library, that's a `Config`
interface validated against a Zod schema (or a similar
typed-config schema). Centralizing config keeps the surface area
easy to audit.

`package.json` declares `"sideEffects": false` **on purpose**: every bit
of module-level state in this package is lazy and import-order-independent
(e.g. the ambient session in `src/api/rosetta.ts` is set only when
`rosetta.session(...)` runs, never at import time), so a bundler may
safely tree-shake any unused entrypoint without changing behaviour. If you
ever add import-time side effects — auto-registration, a module-level
`session(...)`/hook install, a global mutation on load — you MUST
re-evaluate `sideEffects` (mark the offending files, or drop the flag), or
tree-shaking will silently drop the registration.
