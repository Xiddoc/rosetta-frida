# rosetta-frida synthetic test-app fixture

This Gradle project produces **two deterministically-obfuscated APKs**
from one identical Java source tree. The two builds differ only in
the R8 `-applymapping` seed they consume, which forces R8 to pin
specific obfuscated names.

The pair simulates a realistic minor-version rotation:

|                           | v1.0.0                  | v1.1.0                  | Pattern                                   |
| ------------------------- | ----------------------- | ----------------------- | ----------------------------------------- |
| `RemoteService`           | `aaaa`                  | `aaab`                  | class rotates; methods stable             |
| `RemoteService$1`         | `bbbb`                  | `bbbc`                  | anonymous Runnable rotates                |
| `BlobCache`                 | `cccc`                  | `cccc`                  | class stays (uncommon but real)           |
| `Config`                  | `dddd`                  | `ddde`                  | class rotates; **fields shuffle**         |
| `Ticket`                   | `eeee`                  | `eeef`                  | class rotates; methods stable             |
| `Ticket$Companion`         | `ffff`                  | `fffg`                  | nested synthetic rotates                  |
| `Ticket$Reader`            | `gggg`                  | `gggh`                  | inner-instance rotates                    |
| `ErrorCode`               | `hhhh`                  | `hhhi`                  | enum rotates; values stable               |
| `AbstractServiceClient`   | `iiii`                  | `iiij`                  | abstract base rotates                     |
| `AbstractServiceClient$1` | `jjjj`                  | `jjjk`                  | anonymous Runnable rotates                |
| `RemoteServiceClient`     | `kkkk`                  | `kkkl`                  | class rotates; **`apply` method rotates** |
| `PromiseCallback`         | `llll`                  | `lllm`                  | interface rotates                         |
| `IRemoteService`          | `IRemoteService`        | `IRemoteService`        | **AIDL-anchored — never rotates**         |
| `IRemoteService$Stub`     | `IRemoteService$Stub`   | `IRemoteService$Stub`   | AIDL-anchored                             |
| `IServiceCallback`        | `IServiceCallback`      | `IServiceCallback`      | AIDL-anchored                             |
| `IServiceCallback$Stub`   | `IServiceCallback$Stub` | `IServiceCallback$Stub` | AIDL-anchored                             |

Most classes rotate. Most method _letters_ stay (matching the design-
doc §0.2 finding that method names rotate slower than class names).
A couple of intentional outliers cover the "method moved within a
stable class" pattern (`apply` on `RemoteServiceClient`) and the
"class kept the same letter" pattern (`BlobCache`).

## What this is for

The fixture feeds the pipeline-CI integration test that validates the
`sigmatcher → rosetta-frida-map` toolchain end-to-end:

1. CI builds both APKs from this fixture.
2. Sigmatcher (or an equivalent mapper) scans each APK and emits a
   rosetta-frida `.jsonc` map.
3. The emitted map is compared against a hand-authored golden expected
   map.
4. A `rosetta diff` between the v1.0.0 and v1.1.0 maps reproduces the
   rotation matrix above — that's the end-to-end signal the toolchain
   captures real cross-version drift correctly.

The Java source is _designed_ to exercise every feature of the
`RosettaMap` schema at `src/types/map.ts`:

| Schema feature             | Java construct                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `kind: aidl_stub`          | `RemoteService` (extends `IRemoteService.Stub`)                                                           |
| `kind: aidl_callback`      | `IServiceCallback`                                                                                        |
| `kind: class`              | `BlobCache`, `Config`, `Ticket`, `RemoteServiceClient`, `RemoteService`                                      |
| `kind: interface`          | `PromiseCallback`                                                                                         |
| `kind: enum`               | `ErrorCode`                                                                                               |
| `kind: synthetic`          | `Ticket$Companion` plus javac-emitted `access$NNN` accessors from `Ticket$Reader`                           |
| `kind: anonymous`          | `RemoteService$1`, `AbstractServiceClient$1`                                                              |
| Multi-overload methods     | `IRemoteService.requestTicket` (AIDL — 2 overloads), `BlobCache.put` (2 overloads), `Ticket.<init>` (2 ctors) |
| Static fields              | `Config.MAX_RETRIES` (final), `Config.currentDebugLevel` (mutable), `BlobCache.MAX_SIZE`                    |
| Instance fields            | `BlobCache.buffer` (private), `BlobCache.lastEvictedKey` (public), `RemoteServiceClient.sessionId` / `.flags` |
| `aidl_descriptor`          | `IRemoteService.Stub.DESCRIPTOR` (AIDL-generated)                                                         |
| `anchors` (stable strings) | `ROSETTA_ANCHOR` constants on `Config`, `BlobCache`, `RemoteService`                                        |
| `extends` chain            | `RemoteServiceClient extends AbstractServiceClient extends Object`                                        |
| Cross-class signature refs | `IRemoteService.requestTicket(Bundle, IServiceCallback)`, `Ticket$Companion.create(...) → Ticket`            |

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

## See also

- `src/types/map.ts` — the locked `RosettaMap` schema this fixture
  exercises.
- `maps/com.example.app/3.4.5.jsonc` — the canonical example map
  whose feature coverage this fixture mirrors.
- `examples/sample-hook/hook.ts` — the canonical example hook; a
  hook written against `com.example.testapp` real names will look
  morphologically identical.
- CI integration: the wave-2 GitHub Actions workflow (filed
  separately) drives the build-both-APKs + emit-maps + diff-against-
  golden flow.
