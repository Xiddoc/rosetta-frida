# sample-hook

The canonical "what does a real rosetta-frida hook look like" example.
It targets the synthetic app `com.example.app` whose map ships at
`maps/com.example.app/30405.json` (15 anonymized classes covering
AIDL stubs, callback proxies, value objects, and an inner-class
chain).

The same hook source compiles unchanged for any app version that has
a matching map — that's the whole point.

## What the example demonstrates

- **Tier 1 declarative hook** with object-form overload disambiguation
  (`IRemoteService$Stub.requestTicket` has two overloads in the map; the
  simple string form would throw `AmbiguousOverloadError`, so the hook
  uses the `{ class, method, args }` form).
- **Tier 1 declarative hook with instance-field access** inside the
  hook body (`RemoteServiceClient.requestTicket` reads `this.sessionId`
  via `rosetta.field`).
- **Tier 2 static-field read** through a `rosetta.use(...)` proxy
  (`Config.MAX_RETRIES`).
- **Tier 3 diagnostic queries** (`rosetta.map.resolveClass(...)`) and
  event subscription (`rosetta.events.onType('resolve', ...)`).
- **Auto-detect** the running app version via in-process
  `PackageManager.getPackageInfo` (no ADB required).

## Build

```sh
npx frida-compile examples/sample-hook/hook.ts -o hook.bundle.js
```

If you want `rosetta inspect` / `extract` / `patch` to operate on the
compiled bundle, embed the marker block at build time:

```sh
node -e "
  import { emitMarkerBlock, loadMap } from 'rosetta-frida';
  const map = await loadMap('maps/com.example.app/30405.json');
  process.stdout.write(emitMarkerBlock(map));
" > marker.js

cat marker.js hook.bundle.js > hook.bundled.js
```

A future release of rosetta-frida will ship a `frida-compile` plugin
that does this transparently (see design doc §12.2 Q1).

## Run

```sh
# Against a connected device (frida-server running):
frida -U -l hook.bundled.js com.example.app

# Or load via a Python/Node controller; rosetta-frida is just a library
# inside the script, so any controller works.
```

## Inspecting + patching the compiled bundle

Once the marker block is embedded, the CLI tools can work on the
bundle without recompiling:

```sh
# What does this bundle target?
npx rosetta inspect hook.bundled.js
# → com.example.app@3.4.5, schema_version 2, 15 classes

# Pull the embedded map back out (for diff/debug):
npx rosetta extract hook.bundled.js -o extracted.json

# Swap in a different version's map without recompiling:
npx rosetta patch hook.bundled.js --map maps/com.example.app/3.5.0.json
```
