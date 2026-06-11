# 🗿 rosetta-frida

> Write Frida hooks against **real** Java class and method names — a
> per-version translation layer handles the obfuscated names that
> actually exist at runtime. Write once, hook many versions.

[![CI](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiddoc/rosetta-frida/actions/workflows/ci.yml)
[![Docs](https://github.com/Xiddoc/rosetta-frida/actions/workflows/pages.yml/badge.svg)](https://xiddoc.github.io/rosetta-frida/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What it is

Every minor release of a large obfuscated Android app rotates the class
and method names that Frida hooks reference, so a hook that worked
yesterday breaks today. rosetta-frida decouples _what_ you want to hook
(the real name) from _how it is spelled today_ (the obfuscated name) by
loading a per-version JSON map at attach time. You write one hook
against real names; ship a new map per release, and the same script
keeps working — no static-analysis-and-repatch cycle every version.

## Usage

```typescript
import { rosetta } from 'rosetta-frida';
import map from './maps/com.example.app/30405.json' with { type: 'json' };

Java.perform(() => {
    rosetta.session({ map });

    rosetta.hook('com.example.app.IRemoteService$Stub.requestTicket', function (bundle, callback) {
        console.log('requestTicket:', bundle.keySet());
        return rosetta.proceed(bundle, callback);
    });
});
```

Same source, any version that has a map. The rotation problem
disappears. Full walkthrough in the
[quick start](https://xiddoc.github.io/rosetta-frida/getting-started/quick-start/).

## Install

> **Availability:** the npm package lands with the first tagged release
> (`v*`). Until then, build from source (below) — that is the working
> path today.

Once the first release is published (publishing is **tag-driven**: a
`v*` version tag triggers the release workflow, which rebuilds, re-runs
the 100% coverage gate, and publishes with npm provenance — so a release
can only ship a green build), install it from npm:

```sh
npm install rosetta-frida
```

```ts
import { rosetta } from 'rosetta-frida';
```

This gives you the runtime library and the `rosetta` CLI (run it with
`npx rosetta <command>`).

Today, build from source:

```sh
git clone https://github.com/Xiddoc/rosetta-frida
cd rosetta-frida
npm install
npm run build
```

See the
[installation guide](https://xiddoc.github.io/rosetta-frida/getting-started/installation/)
for requirements and details.

## Documentation

Full docs are published to **[GitHub Pages](https://xiddoc.github.io/rosetta-frida/)**
(source under [`docs/`](docs/index.md)):

- [Getting started](https://xiddoc.github.io/rosetta-frida/getting-started/quick-start/) — install, quick start, concepts
- [API reference](https://xiddoc.github.io/rosetta-frida/api/overview/) — the three-tier hook API + session
- [Map format & authoring](https://xiddoc.github.io/rosetta-frida/maps/format/) — schema 3, `version_code`, authoring
- [CLI reference](https://xiddoc.github.io/rosetta-frida/cli/overview/) — `init`, `pull`, `validate`, `convert`, `patch`, `extract`, `inspect`
- [Recipes](https://xiddoc.github.io/rosetta-frida/recipes/aidl-stub-hook/) — common hook patterns
- [Design](https://xiddoc.github.io/rosetta-frida/reference/design/) and [Roadmap](https://xiddoc.github.io/rosetta-frida/roadmap/) — architecture and what's next
- [Contributing](https://xiddoc.github.io/rosetta-frida/contributing/) — dev setup, the verify pipeline, conventions

## License

[MIT](LICENSE)
</content>
</invoke>
