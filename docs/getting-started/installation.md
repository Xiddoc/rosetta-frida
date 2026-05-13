# Installation

rosetta-frida is a regular npm package. It runs inside a Frida script
(authored in TypeScript or JavaScript and compiled with
[`frida-compile`](https://github.com/frida/frida-compile)) and ships a
CLI binary, `rosetta`, for map authoring and bundle manipulation.

## Requirements

- **Node.js 18.18 or newer.** The library uses ESM modules, native
  fetch, and a handful of post-18 stdlib APIs.
- **Frida 16 or newer** in the target environment (`frida-server` on
  the device, plus whichever controller you use — Python `frida`,
  `frida` CLI, `frida-node`). The library is tested against Frida 16
  and 17.
- **`frida-compile` 16+** for compiling TypeScript or modern
  JavaScript hooks into a single bundle Frida can load.

There is no Python, Java, or Android-SDK dependency on the host
running rosetta-frida. The CLI is pure Node; the runtime is pure JS
that loads inside Frida's Quickjs / V8 sandbox.

## Install

=== "npm"

    ```sh
    npm install --save rosetta-frida
    ```

=== "pnpm"

    ```sh
    pnpm add rosetta-frida
    ```

=== "yarn"

    ```sh
    yarn add rosetta-frida
    ```

This installs:

- The runtime library at `rosetta-frida` (default ESM import).
- The CLI at `node_modules/.bin/rosetta`. Add it to your `PATH` via
  `npx rosetta <command>` or `npm run rosetta -- <command>` from a
  `scripts` entry.

### Peer dependencies

rosetta-frida itself depends only on `yaml` (for the YAML converter)
and `zod` (for schema validation). Both are regular dependencies, not
peers — you do not need to install them yourself.

You do need `frida-compile` to *compile* hooks. It is the standard
build step for any non-trivial Frida script. Install it once globally
or per-project:

```sh
npm install --save-dev frida-compile
```

## Verify the install

```sh
npx rosetta --help
```

You should see:

```text
Usage: rosetta <command> [options]

Commands:
  init <app> <version>                 Scaffold a new map skeleton
  validate <map>                       Schema + sanity check (auto-detect format)
  convert <in> -o <out>                Convert YAML/TS module to canonical JSONC
  patch <bundle.js> --map <new.jsonc>  Replace embedded map in bundle
  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle (JSON output)
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
