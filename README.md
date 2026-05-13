# rosetta-frida

> Write Frida hooks against **real** Java class and method names. A
> per-version translation layer handles the obfuscated names that
> actually exist at runtime in the target app.
>
> Write once, hook many versions.

[![CI](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml)
[![Docs](https://github.com/Xiddoc/rosetta-frida/actions/workflows/docs.yml/badge.svg)](https://xiddoc.github.io/rosetta-frida/)
[![Tests](https://img.shields.io/badge/tests-595%20passing-brightgreen)](#testing)
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
time using a per-version JSONC map:

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

**1. Get a map for your target app.** Either author one yourself (start
with `rosetta init`) or — eventually — pull from the community
[maps repo](#status).

```sh
npx rosetta init com.example.app 3.4.5
# → wrote maps/com.example.app/3.4.5.jsonc  (JSONC = JSON with comments)
# edit the scaffold to fill in your real → obfuscated mappings
npx rosetta validate maps/com.example.app/3.4.5.jsonc
# → OK: ...@3.4.5, 1 class(es), schema_version=1
```

**2. Write a hook.** The full sample lives in `examples/sample-hook/`:

```typescript
import { rosetta } from 'rosetta-frida';
import map from './maps/com.example.app/3.4.5.json' with { type: 'json' };
// (Author maps in .jsonc with comments; convert to .json for bundling
// until the V1.5 frida-compile plugin handles .jsonc natively.)

Java.perform(() => {
    rosetta.session({ map, failurePolicy: 'warn' });

    // Tier 1 — declarative one-liner.
    rosetta.hook('com.example.app.BlobCache.get', function (key) {
        console.log('cache.get', key);
        return rosetta.proceed(key);
    });

    // Tier 2 — Java.use-shaped (with real-name overload args).
    const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
    console.log(`live mapping: ${Stub.$realName} -> ${Stub.$obfName}`);

    // Tier 3 — raw map queries / runtime overrides.
    rosetta.events.onType('resolve', (e) => {
        if (e.miss) console.warn('unresolved:', e.name);
    });
});
```

**3. Bundle with `frida-compile`** and attach with any controller (Python,
Node, `frida` CLI — all unchanged):

```sh
npx frida-compile hook.ts -o hook.bundle.js
frida -U -l hook.bundle.js com.example.app
```

## Features

- **Three API tiers** — declarative one-liners for common cases
  (`rosetta.hook`), Java.use-shaped intermediate access (`rosetta.use`),
  raw map queries for escape hatches (`rosetta.map`).
- **Strict validation** — Zod schemas reject malformed maps with
  structured error reports. No silent corruption when a map drifts.
- **Attach-time health check** — verifies the loaded map matches the
  running app by sampling class resolution + AIDL descriptors + anchor
  strings. Fails fast in `strict` mode.
- **In-process auto-detect** — pulls the running app's package + version
  from `PackageManager.getPackageInfo` inside the Frida script. No ADB
  required; works over frida-server TCP.
- **PEM-style marker block** — every bundled map gets wrapped in a
  recognizable `-----BEGIN ROSETTA MAP-----` block so tools can extract,
  patch, or inspect it without recompiling.
- **CLI for the whole lifecycle** — `init`, `validate`, `convert` (from
  YAML/TS), `patch`, `extract`, `inspect`.
- **TypeScript-native** — strict types throughout; the locked contracts
  under `src/types/` mean third-party tools can build against a stable
  surface.

## CLI

```
rosetta init <app> <version>                  Scaffold a new map skeleton
rosetta validate <map>                        Schema + sanity check (auto-detect format)
rosetta convert <in> -o <out>                 Convert YAML / TS module to canonical JSONC
rosetta patch <bundle.js> --map <new.json>    Replace embedded map in a compiled bundle
rosetta extract <bundle.js> -o <out.json>     Pull embedded map out of a compiled bundle
rosetta inspect <bundle.js>                   One-line summary of an embedded map
```

Full reference: see the [CLI docs](https://xiddoc.github.io/rosetta-frida/cli/overview/).

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

V1.0 is functionally complete and exercised by 595 tests at 100%
line/branch/function/statement coverage. The library has not yet
been published to npm; install from the GitHub master branch if you
want to try it now.

### Roadmap

| Version        | Focus                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.0 (current) | Java-only runtime + CLI. Maps live in this repo.                                                                                            |
| V1.5           | `rosetta diff` / `merge` / `types` / `verify` CLI commands. Multi-version registry bundles. Fuzzy version matching.                         |
| V2             | Self-healing runtime discovery. Separate `rosetta-frida-maps/` community repo. Frida-compile plugin for transparent marker-block injection. |
| V3             | Native (JNI / ELF) symbol mapping. Non-Frida runtimes (Xposed, LSPosed). Hosted resolution service.                                         |

## Documentation

The full documentation lives at **https://xiddoc.github.io/rosetta-frida/**
(once the docs workflow runs on a `master` push to a configured
GitHub Pages source):

- [Getting started](https://xiddoc.github.io/rosetta-frida/getting-started/quick-start/)
- [API reference](https://xiddoc.github.io/rosetta-frida/api/overview/) — every public surface
- [Map authoring guide](https://xiddoc.github.io/rosetta-frida/maps/authoring/)
- [CLI reference](https://xiddoc.github.io/rosetta-frida/cli/overview/)
- [Recipes](https://xiddoc.github.io/rosetta-frida/recipes/aidl-stub-hook/) — common patterns
- [Design doc](https://xiddoc.github.io/rosetta-frida/reference/design/) — architecture overview

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

See [CONTRIBUTING](https://xiddoc.github.io/rosetta-frida/contributing/)
for the longer version.

## License

[MIT](LICENSE)

---

_The name comes from the Rosetta Stone — a translation key between
languages you can read and languages you can't._
