# 🗿 rosetta-frida

> Write Frida hooks against **real** Java class and method names. A
> per-version translation layer handles the obfuscated names that
> actually exist at runtime in the target app.
>
> Write once, hook many versions.

[![CI](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml)
[![Docs](https://github.com/Xiddoc/rosetta-frida/actions/workflows/docs.yml/badge.svg)](https://xiddoc.github.io/rosetta-frida/)
[![Tests](https://img.shields.io/badge/tests-611%20passing-brightgreen)](#testing)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## The problem

Every minor release of a large obfuscated Android app rotates the class
and method names that Frida hooks reference. The hook that worked yesterday
breaks today:

```js
// hook for version 3.4.5:
const Stub = Java.use('aaaa');
Stub.c.overload('android.os.Bundle', 'bbbb').implementation = function (b, cb) {
    console.log('requestTicket:', b.keySet());
    return this.c(b, cb);
};

// version 3.5.0 ships. `aaaa` is now an unrelated `Runnable`,
// and the real class is now `aaab`. The script crashes silently.
```

The cycle: static-analysis pass → patch every hook → re-compile → re-test.
Per release. Per script.

## The fix

Write hooks against **real names**. rosetta-frida translates them at attach
time using a per-version JSON map:

```typescript
import { rosetta } from 'rosetta-frida';
import map from './maps/com.example.app/3.4.5.json' with { type: 'json' };

Java.perform(() => {
    rosetta.session({ map });

    rosetta.hook(
        {
            class: 'com.example.app.IRemoteService$Stub',
            method: 'requestTicket',
            args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
        },
        function (bundle, callback) {
            console.log('requestTicket:', bundle.keySet());
            return rosetta.proceed(bundle, callback);
        },
    );
});
```

Same source, any version with a map. The rotation problem disappears.

## Install

```sh
npm install rosetta-frida
```

Requires Node ≥24 (build-time only — the bundled hook runs in Frida's
JS sandbox like any other Frida script). Older Node versions are
unsupported; GitHub Actions is phasing them out of its hosted
runners.

## Quick start

1. **Scaffold a map** for your target with `rosetta init com.example.app
3.4.5`, fill in the real → obfuscated names, and `rosetta validate`
   it. (Strict JSON, `schema_version: 2`; author in YAML/TS and `rosetta
convert` if you prefer comments.)
2. **Write a hook** against real names — see the example above, or the
   full three-tier sample in `examples/sample-hook/`.
3. **Bundle and attach** with your usual toolchain — nothing else
   changes:

    ```sh
    npx frida-compile hook.ts -o hook.bundle.js
    frida -U -l hook.bundle.js com.example.app
    ```

Full walkthrough: [docs/getting-started/quick-start.md](docs/getting-started/quick-start.md).

## Features

- **Three API tiers** — declarative one-liners (`rosetta.hook`),
  `Java.use`-shaped access (`rosetta.use`), and raw map queries
  (`rosetta.map`). See [docs/api/overview.md](docs/api/overview.md).
- **Strict validation** — Zod schemas reject malformed maps with
  structured error reports; no silent corruption when a map drifts.
- **Attach-time health check** — verifies the loaded map matches the
  running app (class resolution, AIDL descriptors, anchor strings) and
  fails fast in `strict` mode.
- **In-process auto-detect** — reads the running app's package + version
  via `PackageManager.getPackageInfo`. No ADB required.
- **PEM-style marker block** — bundled maps are wrapped in a
  `-----BEGIN ROSETTA MAP-----` block so tools can extract, patch, or
  inspect them without recompiling. See
  [docs/maps/marker-block.md](docs/maps/marker-block.md).
- **CLI for the whole lifecycle** — `init`, `validate`, `convert`,
  `patch`, `extract`, `inspect`. See
  [docs/cli/overview.md](docs/cli/overview.md).
- **TypeScript-native** — strict types throughout; locked contracts
  under `src/types/` give third-party tools a stable surface.

## What rosetta-frida is _not_

- **Not a deobfuscator.** It consumes maps. Use jadx / sigmatcher /
  hand-authoring to produce them.
- **Not a hook framework.** It doesn't define what a "hook" is — Frida
  does. rosetta-frida just makes `Java.use` smarter.
- **Not a host-side orchestrator.** It's a library that runs inside the
  Frida JS script. Your Python / Node / CLI controller stays unchanged.
- **Not iOS / desktop / non-Android Frida** (V1.0). Future versions may
  add native-side mapping and non-Android targets.
- **Not an auto-discoverer of obfuscated names** (V1.0). Maps are the
  only source of translation. Self-healing runtime discovery is on the
  V2+ roadmap.

## Status

V1.0 is functionally complete and exercised by 611 tests at 100%
line/branch/function/statement coverage. The library has not yet
been published to npm; install from the GitHub master branch if you
want to try it now.

### Roadmap

| Version        | Focus                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.0 (current) | Java-only runtime + CLI. Maps live in this repo.                                                                                                                                            |
| V1.5           | `rosetta diff` / `merge` / `types` / `verify` CLI commands. Multi-version registry bundles. Fuzzy version matching.                                                                         |
| V2             | Self-healing runtime discovery. Separate [`rosetta-maps`](https://github.com/Xiddoc/rosetta-maps) community repo (scaffolded). Frida-compile plugin for transparent marker-block injection. |
| V3             | Native (JNI / ELF) symbol mapping. Non-Frida runtimes — [`rosetta-xposed`](https://github.com/Xiddoc/rosetta-xposed) (Xposed / LSPosed / LSPatch, scaffolded). Hosted resolution service.   |

## Documentation

Full docs live under [`docs/`](docs/index.md) (also published to
[GitHub Pages](https://xiddoc.github.io/rosetta-frida/)):

- [Getting started](docs/getting-started/quick-start.md) — install, quick start, concepts
- [API reference](docs/api/overview.md) — every public surface (three tiers + session)
- [Map format & authoring](docs/maps/format.md) — schema 2, `version_code`, authoring guide
- [CLI reference](docs/cli/overview.md) — `init`, `validate`, `convert`, `patch`, `extract`, `inspect`
- [Recipes](docs/recipes/aidl-stub-hook.md) — common hook patterns
- [Design doc](docs/reference/design.md) — architecture
- [Roadmap](docs/roadmap.md) — what's next, and why

## Testing

```sh
npm test                  # run the full Vitest suite
npm run test:coverage     # enforce 100% line/branch/function/statement coverage
npm run verify            # typecheck + lint + format + coverage in one go
```

The repo's CI runs `verify` on every push and PR across a Node version
matrix. See `.github/workflows/ci.yml`.

## Contributing

The library was built in parallel-agent waves against locked interface
contracts in `src/types/`. To extend it:

1. If you're adding a new subsystem, start by sketching the type
   contract in `src/types/` first; downstream code depends on those
   shapes.
2. Co-locate tests with the source (`src/foo/foo.test.ts`).
3. Use the Frida mock at `tests/mocks/` for any code that touches
   `Java.use` — no real device needed.
4. Run `npm run verify` before pushing. The 100% coverage gate is
   enforced in CI.

See [docs/contributing.md](docs/contributing.md) for the longer version.

## License

[MIT](LICENSE)
