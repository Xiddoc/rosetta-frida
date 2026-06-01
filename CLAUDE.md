# CLAUDE.md — rosetta-frida

@../CLAUDE.md

## What this project is

A library that lets you write Frida hooks against **real (unobfuscated)
class and method names**, with a translation layer that resolves them
to the obfuscated names that actually exist at runtime in the target
app. The translation tables are **per-app, per-version** YAML files
that the library loads at attach time.

Write once, hook many versions.

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
- We *partially* mitigated this in past projects by writing
  **adaptive Frida hooks** that discover the right methods at runtime
  by *signature* (e.g. "find the method on `aaaa` whose signature is
  `(Bundle, IInterface) → void`"). That works when the class name is
  stable but the method name moved — but it fails when the class name
  itself rotates (because we don't know where to *start* the
  signature search). It also doesn't help anyone *reading* the hook
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
- Not a sigmatcher PR. Sigmatcher *produces* obfuscation maps from
  static analysis; this tool *consumes* them. Different concerns,
  different upstream/downstream positions. Clean split: sigmatcher
  (and other tools) emit a canonical mapping file format; this tool
  reads that format. That way sigmatcher stays focused and rosetta-
  frida can take inputs from any mapper (sigmatcher + hand-authored
  + runtime-discovered all merge into the same format).
- **Standalone npm package.** Frida hooks are JS. `frida-compile`
  and `frida-java-bridge` are already established tooling. Same
  distribution channel makes sense.

## API design — runtime wrapper (not codegen)

**Decided:**

There were two candidate architectures:

| Approach | Pros | Cons |
|---|---|---|
| **(A) Codegen** — preprocess hook source to substitute real names with obfuscated names ahead of time; output is a normal Frida script | Zero runtime overhead; output is debuggable Frida JS | Per-version build artifacts; can't switch mappings at runtime; loses the "same hook works for any version" property |
| **(B) Runtime wrapper** — `m.use(realName)` proxies to `Java.use(obfName)`; mapping loaded at attach time | One hook script works across versions; auto-detection possible; mapping can be hot-swapped | Slightly slower startup; dynamic proxy = more failure modes to surface |

**Decision: (B) runtime wrapper.** The killer feature is "same hook
script works against any version that has a mapping file." Worth the
small runtime cost.

### API sketch

```js
const Rosetta = require('rosetta-frida');

// Attach: detect app/version, load mapping, return a bridge.
const m = await Rosetta.attach({
    app: 'com.example.app',             // optional — detected from active process
    version: 'auto',                     // 'auto' reads from dumpsys; or "3.4.5"
    mapping: undefined,                  // optional path to a local mapping override
});

// Use a class by REAL name. The bridge translates to the obfuscated
// name in the loaded mapping.
const Stub = m.use(
    'com.example.app.service.IRemoteService$Stub'
);

// Hook a method by REAL name. The proxy translates method names too.
// `m.type(...)` resolves a type for overload-disambiguation.
Stub.requestTicket
    .overload('android.os.Bundle', m.type('IServiceCallback'))
    .implementation = function (bundle, callback) {
        console.log('request keys:', bundle.keySet());
        return this.requestTicket(bundle, callback);
    };
```

Behind the scenes:
- `m.use('com.example.app.service.IRemoteService$Stub')`
  → looks up real name in mapping → finds `aaaa` (or `aaab`, depending
  on version) → calls `Java.use('aaaa')` → returns a proxy that
  re-resolves field/method accesses through the mapping.
- `Stub.requestTicket` → looks up the method on the resolved
  class in the mapping → finds method `c` → returns
  `Java.use('aaaa').c` (an overload bundle).
- `m.type('IServiceCallback')` → resolves the AIDL
  callback type's obfuscated name (e.g. `bbbb` or `bbcc`).

## Mapping file format

**Resolved (post-RFC-0001):** the canonical on-disk artifact is
**strict JSON** (`schema_version: 2`), one file per
`(app, version_code)`, stored under a maps directory loaded at attach
time. YAML and TS modules remain *authoring inputs* converted to JSON
via `rosetta convert` — the YAML below is shown for authoring
flavour. Two app-identity changes landed with schema 2:

- **`version_code` is required and authoritative.** It is the Android
  `PackageInfo.versionCode` (or low 32 bits of `longVersionCode`) and
  is the primary, O(1) key the runtime selects maps by. The `version`
  (versionName) string is a human label / fuzzy fallback only.
- **`signer_sha256`** (optional) replaced `apk_sha256`: it is the hash
  of the signing certificate, a cheap on-device authenticity guard
  (the APK-bytes hash never belonged in a per-version selection key).

```yaml
# authoring source — rosetta convert renders this to 3.4.5.json
app: com.example.app
version: "3.4.5"
version_code: 30405
captured_at: 2026-05-11
sources:
  - tool: sigmatcher
    config: signatures/app.yaml
    classes: 47
  - tool: hand-authored
    classes: 12
    notes: "cccc.v signature confirmed via Frida runtime trace, see commit <hash>"
  - tool: rosetta-frida-runtime-discovered
    classes: 3
    notes: "stub_candidate scan emitted these names at attach"

classes:
  com.example.app.service.IRemoteService$Stub:
    obfuscated: aaaa
    extends: zzzz
    dex: classes6.dex
    methods:
      requestTicket:
        obfuscated: c
        signature: "(Landroid/os/Bundle;Lbbbb;)V"
        aidl_txn: 2
      requestPrompt:
        obfuscated: f
        signature: "(Landroid/os/Bundle;Lbbbc;)V"
        aidl_txn: 3
    fields: {}

  IServiceCallback:                # interface, resolves a type alias
    obfuscated: bbbb
    kind: aidl_callback
```

Why YAML/TS *for authoring* (the canonical artifact is still strict
JSON):
- Human-readable and human-writable (a lot of these will be hand-
  authored or hand-edited).
- Comments are first-class (`# notes here`) in the authoring source.
- Multi-line strings work naturally.

The on-disk *artifact* is strict JSON (no comments) so it imports
natively into any bundler / `frida-compile` and round-trips through
`JSON.parse` without a custom parser. Keep comment-bearing notes in a
YAML/TS authoring source and re-render with `rosetta convert`.

## Distribution model — separate maps repo

**The long-term killer feature:** a public, community-contributed
repository of mapping files. Like an obfuscation-map "CVE database."
Someone writes a hook for an app, the tool fetches the latest
community-contributed map for their installed version, the hook
works — even if the original hook author never tested against that
exact version.

Two repos at maturity:

- **`rosetta-frida/`** (this repo) — library + bridge code.
- **`rosetta-frida-maps/`** (separate repo, planned) — contributed
  maps. PR-gated by automated YAML schema validation; no code review
  required. Each PR adds or updates a single `<app>/<version>.yaml`.

The library, at attach time, can optionally fetch from the maps repo
if no local override exists. Caching keyed by `(app, version)`.

**Not in V1.** For the MVP, maps live in the same repo
(`rosetta-frida/maps/`) and ship with the library.

## Open questions (these are the unfinished design decisions)

These are the things I didn't fully nail down with the user before
starting this project. The new Claude session that picks this up
should resolve them with the user before locking implementation
choices in.

### 1. Project naming

Working name: **`rosetta-frida`** (translation metaphor; my pick).

Other options the user said to keep on the table:
- `frida-decode` — descriptive
- `unrot` / `unrotate` — too clever?
- `obf-bridge` — utility-flavoured

If the user picks a different name, rename the project directory
and update this CLAUDE.md.

### 2. Native (libffi / C symbols) coverage?

Frida hooks both Java and native. JNI / native symbols *also* rotate
per release. Should V1 cover both, or Java-only?

- **Java-only V1, native V2:** simpler scope, ships sooner. Past
  experience suggests Java-side rotation is the dominant pain.
- **Both V1:** unified API from the start.

My lean: **Java-only V1.** Native is a different mapping shape
(function pointers, demangled symbols, base offsets) and would
significantly complicate the file format.

### 3. Fuzzy-version matching?

If you have a map for `3.4.5` and the device runs `3.4.6`, do
you:
- (a) Fall back to the closest map with a warning,
- (b) Fail hard and tell the user to provide a map for that exact
  version?

My lean: **(b) fail hard by default, opt-in fuzzy via config flag.**
Wrong-version maps silently corrupt hooks; the failure mode of
loading the wrong map is worse than the failure mode of having to
either generate a new map or pass `--allow-fuzzy`.

### 4. MVP scope

The minimum useful prototype I'd target:
- One app.
- One version.
- A hand-written YAML mapping covering 10-20 classes (those that
  are useful for a representative capture workflow).
- The wrapper APIs: `Rosetta.attach()`, `m.use()`, `m.type()`,
  `m.method()` — but **no** auto-detect (require explicit `version`).
- No remote-map-fetching, no fuzzy-version-matching.
- No CLI, no test harness for maps yet.
- A `frida-compile` example showing how to bundle a hook that uses
  rosetta-frida.

Estimated time: a weekend.

Question: is this the right MVP scope, or does the user want
something smaller / larger?

### 5. TypeScript vs plain JS?

Frida's runtime is JS. The library's *runtime code* must be JS.
But the *source* could be TypeScript that compiles to JS — same
pattern as `frida-java-bridge` and `frida-il2cpp-bridge`.

My lean: **TypeScript source → JS output.** The mapping file types,
the bridge class, the proxy returned from `m.use()` all benefit
substantially from types. Adds a build step but is worth it for
mid-size library code.

### 6. How does `Rosetta.attach()` actually detect the live app version?

`'auto'` is the desired UX, but implementation has trade-offs:
- **adb shell dumpsys package <pkg>** — requires adb access from the
  Frida-controlling host, which capture-style orchestrators typically
  already have. Works.
- **Read from inside the target process** via Java's
  `Context.getPackageManager().getPackageInfo(pkg, 0).versionName`.
  Frida can do this. Cleaner, no external dependency on adb.

My lean: **in-process via PackageManager**, with adb as fallback for
contexts where you don't have a `Context` yet.

### 7. Versioning the mapping file format itself?

We'll learn things about the schema as we go. The top-level
`schema_version` field exists from day 1 so format changes can be
detected and handled. **Resolved:** the current schema is `2` — the
RFC-0001 app-identity refinement made `version_code` required, added
the optional `signer_sha256` guard, and dropped `apk_sha256`. The
literal is a hard gate (`z.literal(2)`); `schema_version: 1` maps are
rejected and must be re-emitted with a `version_code`.

## When to NOT use rosetta-frida (anti-scope)

These are explicit anti-features — things rosetta-frida should not try
to do, at least in V1, so the new Claude session doesn't accidentally
scope-creep:

- **Not a deobfuscator.** It does not analyze APKs and *produce*
  mappings. It only *consumes* them. Use sigmatcher (or jadx + manual
  work) to produce maps.
- **Not a Frida wrapper for non-Java targets.** V1 is Java/Kotlin
  Android apps only. iOS / desktop / Linux targets are out of scope.
- **Not a hook framework.** It doesn't define what a "hook" is. It
  just makes `Java.use` smarter. Users still write `.implementation =
  function() { ... }`.
- **Not a sigmatcher replacement.** It does not duplicate sigmatcher's
  signature-matching logic. Sigmatcher is one upstream input among
  several.

## Suggested next steps for a fresh session

When the user launches a new Claude session in this directory:

1. **Read this CLAUDE.md end-to-end.** It contains every design
   decision and open question.
2. **Resolve open questions §1-§7 with the user before writing code.**
   Don't lock implementation choices in unilaterally — those are real
   trade-offs that need the user's input.
3. **Write a `README.md`** that's the user-facing entry point (this
   CLAUDE.md is for Claude; README is for humans reading the GitHub
   page if/when published).
4. **Scaffold the npm package** (`package.json`, `tsconfig.json` if
   TypeScript, a standard Node `.gitignore`).
5. **Start with the V1 MVP scope from §4** — one app, one version,
   hand-written 10-class map, the four wrapper APIs.
6. **Validate by porting an existing adaptive-discovery Frida hook**
   to use rosetta-frida. A small hook that targets just a couple of
   rotation-prone classes is the ideal first port — exactly the
   pattern this library exists to simplify.

## Memory

Configuration in this project (map paths, fetch URLs, log levels,
etc.) should flow through a **typed config object**, not `process.env`
lookups sprinkled around. For a TypeScript library, that's a `Config`
interface validated against a Zod schema (or a similar
typed-config schema). Centralizing config keeps the surface area
easy to audit.
