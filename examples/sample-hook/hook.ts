/**
 * Sample rosetta-frida hook.
 *
 * This is the canonical "what does a real hook look like" example.
 * It targets the synthetic app `com.example.app` whose map ships at
 * `maps/com.example.app/3.4.5.jsonc` (15 classes covering AIDL stubs,
 * callback proxies, value objects, etc.).
 *
 * The same source compiles unchanged for any app version that has a
 * matching map — that's the whole point of rosetta-frida.
 *
 * Build (V1.0):
 *
 *   # JSONC isn't natively importable by bundlers, so convert to JSON
 *   # first. V1.5 ships a frida-compile plugin that handles .jsonc directly.
 *   npx rosetta convert maps/com.example.app/3.4.5.jsonc -o /tmp/map.json
 *   npx frida-compile examples/sample-hook/hook.ts -o hook.bundle.js
 *
 *   # For inspect/extract/patch to work on the bundle, wrap the map
 *   # import in a marker block — see examples/sample-hook/README.md.
 *
 * Run:
 *
 *   frida -U -l hook.bundle.js com.example.app
 *   # or via the Python/Node controller you already use
 */

// Until the V1.5 frida-compile plugin lands, the bundle import points
// at a tooling-generated `.json` sibling of the canonical `.jsonc`.
// Run `npx rosetta convert maps/com.example.app/3.4.5.jsonc -o ...`
// to produce it before bundling.
// @ts-expect-error — the JSON sibling is generated at build time;
// TypeScript will complain until you run the convert step. Suppressed
// so the example still typechecks against the canonical .jsonc source.
import sampleMap from '../../maps/com.example.app/3.4.5.json' with { type: 'json' };
import { rosetta, type RosettaMap } from '../../src/index.js';

// Cast the imported JSON to RosettaMap (TypeScript's JSON import yields
// a deeply-frozen literal type; the runtime shape matches).
const map = sampleMap as unknown as RosettaMap;

Java.perform(() => {
    rosetta.session({
        map,
        // No `app` / `version` — let rosetta auto-detect via
        // ActivityThread.currentApplication().getPackageManager().
        // Falls through to an error if the running app doesn't match
        // (com.example.app @ 3.4.5).
        trace: true,
        // In a real script you'd typically pick 'warn' for production
        // and 'strict' for CI. Default is 'warn'.
        failurePolicy: 'warn',
    });

    // ----------------------------------------------------------------
    // Tier 1 — declarative method hooks.
    //
    // `IRemoteService$Stub.requestTicket` has multiple overloads in the
    // map (`c` and `d`). The simple-string form would throw an
    // AmbiguousOverloadError because the library doesn't know which to
    // pick, so we use the object form to disambiguate by real-name arg
    // types.
    // ----------------------------------------------------------------
    rosetta.hook(
        {
            class: 'com.example.app.IRemoteService$Stub',
            method: 'requestTicket',
            args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
        },
        function (bundle: unknown, callback: unknown) {
            send({
                channel: 'sample',
                stage: 'requestTicket',
                bundleKeys: bundleKeys(bundle),
            });
            return rosetta.proceed(bundle, callback);
        },
    );

    // ----------------------------------------------------------------
    // Tier 2 — Java.use-shaped access for a static field.
    //
    // `Config.MAX_RETRIES` is a static int. Read once, log it, then
    // override it (still in-process) to demonstrate field writes.
    // ----------------------------------------------------------------
    const Config = rosetta.use('com.example.app.Config');
    const original = Config.MAX_RETRIES.value as number;
    send({ channel: 'sample', stage: 'config-snapshot', maxRetries: original });

    // ----------------------------------------------------------------
    // Tier 2 — instance field access inside a tier-1 method hook.
    //
    // Demonstrates the canonical pattern of intercepting a method, then
    // reading instance fields off `this` via real names.
    // ----------------------------------------------------------------
    rosetta.hook(
        'com.example.app.RemoteServiceClient.requestTicket',
        function (this: unknown, ...args: unknown[]) {
            const sid = rosetta.field(this, 'sessionId') as string | null;
            send({ channel: 'sample', stage: 'client-call', sessionId: sid });
            return rosetta.proceed(...args);
        },
    );

    // ----------------------------------------------------------------
    // Tier 3 — diagnostic queries.
    //
    // Inspect what the loaded map says about a class without installing
    // a hook. Useful for adaptive logic that branches on whether a real
    // name was actually mapped this release.
    // ----------------------------------------------------------------
    const blobCache = rosetta.map.resolveClass('com.example.app.BlobCache');
    send({
        channel: 'sample',
        stage: 'tier-3-query',
        BlobCache: { real: blobCache.realName, obf: blobCache.obfName, kind: blobCache.entry.kind },
    });

    // Listen for any unresolved-name events emitted by the resolver —
    // useful at attach time to surface map gaps before they become
    // mysterious null/undefined errors deeper in the hook.
    rosetta.events.onType('resolve', (e) => {
        if (e.miss) {
            send({ channel: 'sample', stage: 'unresolved', name: e.name, scope: e.classScope });
        }
    });
});

/** Best-effort bundle-keys-as-array helper for diagnostic output. */
function bundleKeys(bundle: unknown): string[] {
    try {
        const b = bundle as { keySet?: () => { toArray?: () => string[] } | null } | null;
        const keySet = b?.keySet?.();
        const arr = keySet?.toArray?.();
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}
