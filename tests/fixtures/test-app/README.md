# rosetta-frida synthetic test-app fixture

This Gradle project produces **two deterministically-obfuscated APKs**
from one identical Java source tree. The two builds differ only in
the R8 `-applymapping` seed they consume, which forces R8 to pin
specific obfuscated names.

The pair simulates a realistic minor-version rotation:

This table is the **actual** R8 output for the two seeds (verified by
`regenerate-goldens.sh`), not an aspiration:

|                           | v1.0.0                  | v1.1.0                  | Pattern                                             |
| ------------------------- | ----------------------- | ----------------------- | --------------------------------------------------- |
| `RemoteService`           | `RemoteService`         | `RemoteService`         | manifest `Service` entry — R8 keeps the name        |
| `RemoteService$1`         | `bbbb`                  | `bbbc`                  | anonymous `IRemoteService.Stub` subclass rotates    |
| `RemoteService$1$1`       | `bbbb$a`                | `bbbc$a`                | nested anonymous `Runnable` rotates with its parent |
| `BlobCache`               | `cccc`                  | `cccc`                  | class stays (uncommon but real)                     |
| `Config`                  | `dddd`                  | `ddde`                  | class rotates; **fields shuffle**                   |
| `Ticket`                  | `eeee`                  | `eeef`                  | class rotates; methods stable                       |
| `Ticket$Companion`        | `ffff`                  | `fffg`                  | nested synthetic rotates                            |
| `Ticket$Reader`           | `gggg`                  | `gggh`                  | inner-instance rotates                              |
| `ErrorCode`               | `hhhh`                  | `hhhi`                  | enum rotates; constants not mapped (see gaps note)  |
| `AbstractServiceClient`   | `iiii`                  | `iiij`                  | abstract base rotates                               |
| `AbstractServiceClient$1` | `jjjj`                  | `jjjk`                  | anonymous Runnable rotates                          |
| `RemoteServiceClient`     | `kkkk`                  | `kkkl`                  | class rotates; **`apply` method rotates**           |
| `PromiseCallback`         | `llll`                  | `lllm`                  | interface rotates                                   |
| `IRemoteService`          | `IRemoteService`        | `IRemoteService`        | **AIDL-anchored — never rotates**                   |
| `IRemoteService$Stub`     | `IRemoteService$Stub`   | `IRemoteService$Stub`   | AIDL-anchored                                       |
| `IServiceCallback`        | `IServiceCallback`      | `IServiceCallback`      | AIDL-anchored                                       |
| `IServiceCallback$Stub`   | `IServiceCallback$Stub` | `IServiceCallback$Stub` | AIDL-anchored                                       |

Most classes rotate. Most method _letters_ stay (matching the design-
doc §0.2 finding that method names rotate slower than class names).
A couple of intentional outliers cover the "method moved within a
stable class" pattern (`apply` on `RemoteServiceClient`) and the
"class kept the same letter" pattern (`BlobCache`).

Two classes stay at their **real** names rather than a four-letter
obfuscation: the AIDL contract surface (`-keep`-pinned) and
`RemoteService` itself — it's the manifest `<service>` entry, so R8
keeps the name and rewrites the manifest in lock-step. The fixture
embraces this (determinism + the cross-version signal matter more than
hitting a specific letter); the anonymous `RemoteService$1` /
`RemoteService$1$1` subclasses underneath it still rotate normally.

### Known member-resolution gaps

Two members are intentionally **not** emitted in the goldens, because
they can't be anchored under sigmatcher 1.9.2's matching model. They are
documented here so the omissions read as deliberate, not as bugs:

- **`ErrorCode` enum constants (`SUCCESS` / `TIMEOUT` / `AUTH_FAILED`).**
  All three share the identical self-type descriptor (`Lhhhh;`) at their
  `.field` declarations, and a single capture has no per-constant
  disambiguator. `ErrorCode` still resolves with `code`, `$VALUES`,
  `ROSETTA_ANCHOR`, and `getCode()`.
- **`RemoteService.safeError`.** R8 splits the private static helper into
  a renamed method plus synthetic `-$$Nest$` access bridges, leaving no
  clean, file-unique descriptor anchor. `RemoteService` still resolves
  richly (its four fields).

## What this is for

The fixture feeds the pipeline-CI integration test that validates the
`sigmatcher → rosetta-frida-map` toolchain end-to-end:

1. CI builds both APKs from this fixture.
2. Sigmatcher (or an equivalent mapper) scans each APK and emits a
   rosetta-frida `.json` map.
3. The emitted map is compared against a hand-authored golden expected
   map.
4. A `rosetta diff` between the v1.0.0 and v1.1.0 maps reproduces the
   rotation matrix above — that's the end-to-end signal the toolchain
   captures real cross-version drift correctly.

The Java source is _designed_ to exercise every feature of the
`RosettaMap` schema at `src/types/map.ts`:

| Schema feature             | Java construct                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind: aidl_stub`          | `RemoteService` (extends `IRemoteService.Stub`)                                                                                                                                  |
| `kind: aidl_callback`      | `IServiceCallback`                                                                                                                                                               |
| `kind: class`              | `BlobCache`, `Config`, `Ticket`, `RemoteServiceClient`, `RemoteService`                                                                                                          |
| `kind: interface`          | `PromiseCallback`                                                                                                                                                                |
| `kind: enum`               | `ErrorCode`                                                                                                                                                                      |
| `kind: synthetic`          | `Ticket$Companion` plus javac-emitted `access$NNN` accessors from `Ticket$Reader`                                                                                                |
| `kind: anonymous`          | `RemoteService$1`, `AbstractServiceClient$1`                                                                                                                                     |
| Multi-overload methods     | `BlobCache.put` (2 overloads), `Ticket.<init>` (2 ctors) — AIDL interfaces forbid overloading, so the overload-array form is exercised by plain classes, not by `IRemoteService` |
| Static fields              | `Config.MAX_RETRIES` (final), `Config.currentDebugLevel` (mutable), `BlobCache.MAX_SIZE`                                                                                         |
| Instance fields            | `BlobCache.buffer` (private), `BlobCache.lastEvictedKey` (public), `RemoteServiceClient.sessionId` / `.flags`                                                                    |
| `aidl_descriptor`          | `IRemoteService.Stub.DESCRIPTOR` (AIDL-generated)                                                                                                                                |
| `anchors` (stable strings) | `ROSETTA_ANCHOR` constants on `Config`, `BlobCache`, `RemoteService`                                                                                                             |
| `extends` chain            | `RemoteServiceClient extends AbstractServiceClient extends Object`                                                                                                               |
| Cross-class signature refs | `IRemoteService.requestTicket(Bundle, IServiceCallback)`, `Ticket$Companion.create(...) → Ticket`                                                                                |

## Building

### Prerequisites

- **JDK 17** (Eclipse Temurin recommended). AGP 8.x officially
  requires JDK 17. Newer JDKs (21+) are not supported by AGP and will
  fail with cryptic stack traces.
- **Android SDK** with `platforms;android-34` and `build-tools;34.0.0`.
- Either point `ANDROID_HOME` / `ANDROID_SDK_ROOT` at your SDK
  installation, or create a `local.properties` file with
  `sdk.dir=/path/to/Android/Sdk`.

The Gradle wrapper itself is checked in — no system `gradle` install
is required.

### Local build commands

```sh
cd tests/fixtures/test-app

# v1.0.0 — seeds R8 with seeds/v1.0.0.applymapping.txt
./gradlew :app:assembleRelease -PapplyMapping=v1.0.0

# v1.1.0 — seeds R8 with seeds/v1.1.0.applymapping.txt
./gradlew :app:assembleRelease -PapplyMapping=v1.1.0
```

The Gradle property is required. If you forget it the build defaults
to `v1.0.0` so the smoke command `./gradlew :app:assembleRelease`
still succeeds, but you should always pass the property explicitly in
CI to avoid confusion.

### Output locations

Both versions produce their APKs at the same path inside the build
directory:

```
app/build/outputs/apk/release/app-release-unsigned.apk
```

Run the v1.0.0 build first, copy its APK aside, then run the v1.1.0
build and copy its APK to a different name. CI does exactly that —
see the wave-2 pipeline workflow when it lands.

R8's actual emitted mapping (the inverse of the applymapping seed,
plus any non-pinned names R8 had to invent) lands at:

```
app/build/outputs/mapping/release/mapping.txt
```

That `mapping.txt` is what sigmatcher / rosetta-frida tooling consume
in CI. It contains both the names we pinned via the seed and any
auto-generated names for classes the seed did not enumerate (e.g. R8
internals like `R$layout` if present).

## Project layout

```
tests/fixtures/test-app/
├── README.md                            ← this file
├── settings.gradle.kts
├── build.gradle.kts                     ← root Gradle script
├── gradle.properties
├── gradlew + gradlew.bat
├── gradle/wrapper/                      ← wrapper jar + properties
└── app/
    ├── build.gradle.kts                 ← AGP config + applymapping wiring
    ├── proguard-rules.pro               ← R8 rules
    ├── seeds/
    │   ├── v1.0.0.applymapping.txt      ← pinned obfuscation seed v1
    │   └── v1.1.0.applymapping.txt      ← pinned obfuscation seed v2
    └── src/main/
        ├── AndroidManifest.xml
        ├── aidl/com/example/testapp/
        │   ├── IRemoteService.aidl
        │   └── IServiceCallback.aidl
        └── java/com/example/testapp/
            ├── RemoteService.java        ← AIDL stub impl + anonymous Runnable
            ├── BlobCache.java              ← multi-overload methods + fields
            ├── Config.java               ← static fields + stable anchor
            ├── Ticket.java                ← inner classes (Companion, Reader)
            ├── ErrorCode.java            ← enum
            ├── AbstractServiceClient.java← abstract base + anonymous Runnable
            ├── RemoteServiceClient.java  ← concrete subclass (extends chain)
            └── PromiseCallback.java      ← SAM interface
```

## Notes for maintainers

- **No APKs are committed.** CI builds them fresh each run. The
  `.gitignore` excludes `app/build/`.
- The applymapping seeds are the **only** thing CI relies on for
  deterministic obfuscation. If you add a new class, method, or
  field to the Java sources, you must add a matching line to both
  seed files or R8 will allocate names from its own pool for the new
  entry, which is non-deterministic across machines.
- The fixture intentionally has **no launcher activity** and **no
  runtime entry point**. It exists to be statically analyzed —
  installing it on a device produces a manifest-validated APK that
  Android can parse, but no `am start` target.
- The AIDL `*.Stub` classes are `-keep`-protected because the binder
  runtime resolves them by descriptor string; rosetta-frida treats
  these as schema-mandated anchors (the schema field is
  `aidl_descriptor`).
- The `ROSETTA_ANCHOR` string constants on `Config`, `BlobCache`, and
  `RemoteService` survive R8 because they're `static final String`
  initializers reached by live code; sigmatcher uses them as discovery
  anchors per the schema's `anchors` array.
- `PromiseCallback`'s anchor is deliberately named `PROMISE_ANCHOR`, not
  `ROSETTA_ANCHOR`. `RemoteServiceClient` implements the interface and
  declares its own `ROSETTA_ANCHOR` field; a same-named static field
  _hides_ the inherited interface constant, and R8 then collapses the
  implementor's field onto the interface field's obfuscated slot
  non-deterministically (it honoured the seed's `-> h` in v1.0.0 but
  reused the interface's `e` in v1.1.0). Distinct names remove the hide,
  so each anchor rotates on its own pinned slot (`-> h` and `-> e`).

## Pipeline CI

The wave-2 GitHub Actions workflow at `.github/workflows/pipeline.yml`
drives the full integration test on every push / pull-request that
touches this fixture, the adapter (`tools/adapters/`), the parser
(`src/parse/`), or the schema (`src/validate/`). It also runs weekly
on a `0 13 * * MON` schedule and on `workflow_dispatch`.

What it does, per run:

1. Builds **both** APKs (`-PapplyMapping=v1.0.0` and `-PapplyMapping=v1.1.0`).
2. Runs `sigmatcher analyze --output-format raw` against each APK
   using `signatures/test-app.yaml`.
3. Pipes each raw output through `tools/adapters/sigmatcher-cli.ts`
   to produce a `.json` `RosettaMap`.
4. Validates the emitted maps via `rosetta validate`.
5. Diffs them against `expected/v1.0.0.json` / `expected/v1.1.0.json`
   — any mismatch fails the workflow with the structured diff visible
   in the run log.
6. Uploads APKs + raw JSON + emitted maps as workflow artifacts
   (retention 14 days) so failures can be reproduced offline.

When you intentionally change the schema, the adapter, the signatures,
or the Java sources / seeds, the goldens will need to be regenerated.
The maintainer-facing script `regenerate-goldens.sh` automates that:

```sh
cd tests/fixtures/test-app
./regenerate-goldens.sh
git diff expected/    # review carefully — any unexpected diff is a bug
git add expected/
git commit -m 'Regenerate test-app goldens: <why>'
```

The script does **not** auto-commit — it builds the APKs, regenerates
the goldens, and prints a `git diff` so you can audit the rotation
exactly once before it lands.

## See also

- `src/types/map.ts` — the locked `RosettaMap` schema this fixture
  exercises.
- `maps/com.example.app/30405.json` — the canonical example map
  whose feature coverage this fixture mirrors.
- `examples/sample-hook/hook.ts` — the canonical example hook; a
  hook written against `com.example.testapp` real names will look
  morphologically identical.
- `.github/workflows/pipeline.yml` — the wave-2 pipeline CI workflow.
- `regenerate-goldens.sh` — maintainer-facing regen script (see
  "Pipeline CI" section above).
- `tools/adapters/sigmatcher.ts` — the sigmatcher → RosettaMap
  adapter the pipeline calls.
