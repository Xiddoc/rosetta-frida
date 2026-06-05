# Installation

rosetta-frida runs inside a Frida script (authored in TypeScript or
JavaScript and compiled with
[`frida-compile`](https://github.com/frida/frida-compile)) and provides
a CLI, `rosetta`, for map authoring and bundle manipulation.

!!! warning "Not on npm yet"

    rosetta-frida is **not published to npm yet** — publishing is
    deliberately deferred. For now you **clone and build from source**
    (below). An npm package is planned for a later phase; once it lands,
    `npm install rosetta-frida` and a published `rosetta` binary will be
    documented here.

## Requirements

- **Node.js 24 or newer** (build/CLI side only — see
  `engines.node` in `package.json`). The compiled hook itself runs in
  Frida's JS sandbox like any other Frida script. Older Node versions
  are unsupported.
- **Frida 16 or newer** in the target environment (`frida-server` on
  the device, plus whichever controller you use — Python `frida`,
  `frida` CLI, `frida-node`). The library is tested against Frida 16
  and 17.
- **`frida-compile` 16+** for compiling TypeScript or modern
  JavaScript hooks into a single bundle Frida can load.

There is no Python, Java, or Android-SDK dependency on the host
running rosetta-frida. The CLI is pure Node; the runtime is pure JS
that loads inside Frida's Quickjs / V8 sandbox.

## Install (clone & build from source)

Until the npm package ships, clone the repo and build it:

```sh
git clone https://github.com/Xiddoc/rosetta-frida
cd rosetta-frida
npm install
npm run build
```

This gives you:

- The runtime library (compiled into `dist/`), importable from a local
  checkout or via a path/`npm link` reference.
- The `rosetta` CLI, run via `npm run cli -- <command>` from the repo
  root.

### Dependencies

rosetta-frida itself depends only on `yaml` (for the YAML converter)
and `zod` (for schema validation); `npm install` pulls both. There are
no peer dependencies to install yourself.

You do need `frida-compile` to *compile* hooks. It is the standard
build step for any non-trivial Frida script:

```sh
npm install --save-dev frida-compile
```

## Verify the install

```sh
npm run cli -- --help
```

You should see:

```text
Usage: rosetta <command> [options]

Commands:
  init <app> <version>                 Scaffold a new map skeleton
  validate <map>                       Schema + sanity check (auto-detect format)
  convert <in> -o <out>                Convert YAML map to canonical JSON
  patch <bundle.js> --map <new.json>   Replace embedded map in bundle
  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle
  inspect <bundle.js>                  One-line summary of embedded map
```

## TypeScript types

The package ships its own `.d.ts` declarations — no separate
`@types/rosetta-frida` package needed.

If you author hooks in TypeScript, add Frida's types so the global
`Java`, `send`, and `Interceptor` symbols resolve:

```sh
npm install --save-dev @types/frida-gum
```

Then in `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "types": ["frida-gum"],
        "resolveJsonModule": true
    }
}
```

`resolveJsonModule` is required for `import map from './x.json'` to
work — that is how maps reach your hook source.

## Next steps

- [Quick start](quick-start.md) — the smallest end-to-end hook.
- [Concepts](concepts.md) — real vs obfuscated names, the rotation
  problem, sessions, marker block.
- [Authoring maps](../maps/authoring.md) — how to write a map for a
  new app or version.
