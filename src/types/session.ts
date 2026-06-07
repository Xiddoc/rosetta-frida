/**
 * Session-level configuration types.
 *
 * These are LOCKED contracts. Wave 2 implements rosetta.session(...) against them.
 */

import type { RosettaMap, RosettaMapRegistry } from './map.js';

/**
 * What happens when a real name has no map entry.
 *
 * - 'strict' — throws ResolveError immediately at the call site.
 * - 'warn'   — logs a warning and returns a sentinel that throws
 *              clearly only when actually used (the deferred-error path).
 *
 * V1 has only these two policies. V2+ adds 'discover' (runtime fallback).
 */
export type FailurePolicy = 'strict' | 'warn';

/**
 * How strict version matching is.
 *
 * - 'exact' — the loaded map's version must exactly match the detected
 *             version (or the user-supplied version override).
 * - 'fuzzy' — fall back to the closest available map (in a registry
 *             bundle) by semver distance, with the health check tightened.
 *
 * Default: 'exact'.
 */
export type VersionMatch = 'exact' | 'fuzzy';

/**
 * Policy for the target-namespace guard (RFC 0001 C1, critical security
 * fix).
 *
 * A community map maps a real name to an ARBITRARY obfuscated string, and
 * the runtime feeds that string verbatim into `Java.use(...)`. A malicious
 * or simply wrong map could therefore redirect a hook at a sensitive
 * framework class — `java.lang.Runtime`, `android.app.*`, a
 * `dagger.internal.Provider`, etc. This policy confines a resolution
 * *target* (the FQN passed to `Java.use`) to the app's own / package-local
 * namespace, with an explicit escape-hatch allowlist for legitimate
 * framework hooks. Anything else is rejected fail-closed — the resolver
 * THROWS `TargetPolicyError` before the `Java.use` call ever happens.
 *
 * There is no warn-and-proceed mode: the guard is STRICT only.
 *
 * This is the Frida twin of the Kotlin `TargetPolicy` in rosetta-xposed;
 * both clients share the same decision order and the same
 * {@link DEFAULT_DENY_PREFIXES} so they accept/reject the same maps.
 */
export interface TargetPolicy {
    /**
     * Caller-supplied reserved top-level prefixes a target may NOT resolve
     * into. When {@link mergeDenylist} is true (the default) these are
     * ADDED to the built-in `DEFAULT_DENY_PREFIXES`; when false they
     * REPLACE the defaults entirely (use with care — that opens framework
     * namespaces). Matched on a dot boundary.
     */
    denyPrefixes?: readonly string[];

    /**
     * Whether {@link denyPrefixes} augment (true, default) or replace
     * (false) the built-in `DEFAULT_DENY_PREFIXES`.
     */
    mergeDenylist?: boolean;

    /**
     * Exact-FQN escape hatch. A target whose normalized element FQN matches
     * an entry here is ALLOWED even if it lands on a reserved prefix — for
     * the rare legitimate framework hook. Exact, case-sensitive match.
     */
    allow?: readonly string[];

    /**
     * How many leading dot-separated labels of the app package form the
     * app's own namespace prefix (default 2, e.g. `com.example` from
     * `com.example.app`).
     */
    appNamespaceLabels?: number;
}

/** User-facing options for `rosetta.session(...)`. */
export interface SessionOptions {
    /**
     * The map (or registry of maps) to use. Required.
     *
     * Single-map: rosetta picks based on the detected version, error if mismatch.
     * Registry: rosetta picks the right per-version map; error if no match.
     *
     * NOTE on parse-limit config (L9): the session accepts an ALREADY-LOADED,
     * already-validated `RosettaMap` / registry — it does no JSON parsing of
     * its own. The pre-parse byte/depth input-hardening caps (the typed
     * config's `parseLimits`) are therefore honored ONLY at the
     * point a map is loaded from text/path via `loadMap(input, config)`;
     * tighten them there, before constructing the session. There is
     * deliberately no `parseLimits` knob on `SessionOptions` because it would
     * be a dead no-op on this object-only input path.
     */
    map: RosettaMap | RosettaMapRegistry;

    /**
     * Override app package name. If omitted, auto-detected in-process via
     * ActivityThread.currentApplication().getPackageName().
     */
    app?: string;

    /**
     * Override app version label. If omitted, auto-detected in-process via
     * PackageManager.getPackageInfo().versionName.
     */
    version?: string;

    /**
     * Override the authoritative version code (PackageInfo.versionCode /
     * longVersionCode). When set — or when auto-detected — this is the
     * primary key used to select a map from a registry; the version label
     * is only the fuzzy-match fallback. If omitted and not auto-detectable,
     * selection falls back to matching on the version label.
     */
    versionCode?: number;

    /** Failure policy when a real name isn't in the map. Default: 'warn'. */
    failurePolicy?: FailurePolicy;

    /** Version matching strictness. Default: 'exact'. */
    versionMatch?: VersionMatch;

    /** If true, prints a readable resolution log to stderr. Default: false. */
    trace?: boolean;

    /**
     * Fraction of mapped classes that must be resolvable via Java.use
     * for the attach-time health check to pass. Default: 0.8.
     * On failure: warn (or fatal in strict failurePolicy).
     */
    healthCheckThreshold?: number;

    /** If true, skip the attach-time health check entirely. Default: false. */
    skipHealthCheck?: boolean;

    /**
     * Whether to enforce the map's signing-certificate authenticity guard
     * (`signer_sha256`) at attach time.
     *
     * When `true` (the default) and the loaded map carries a
     * `signer_sha256`, the session reads the running app's signing
     * certificate in-process, SHA-256's it, and **fails closed** with
     * `SignerMismatchError` if no live signer matches. When the map has no
     * `signer_sha256` the check is skipped regardless of this flag.
     *
     * Set to `false` to opt out of the guard (e.g. when running against a
     * locally re-signed debug build of an app whose map was captured from
     * the production-signed APK). Default: `true` (secure default).
     */
    enforceSigner?: boolean;

    /**
     * Target-namespace guard policy (RFC 0001 C1). Confines the FQNs a map
     * can redirect hooks at to package-local / app-owned namespaces, with
     * an explicit escape-hatch allowlist.
     *
     * Omitted (the default) means: built-in `DEFAULT_DENY_PREFIXES`, empty
     * allowlist, 2 app-namespace labels — i.e. FAIL-CLOSED (a map pointing
     * a hook at `java.lang.Runtime` is rejected with no configuration
     * needed).
     */
    targetPolicy?: TargetPolicy;
}

/** The handle returned from `rosetta.session(...)`. */
export interface Session {
    /** The active map (resolved from registry if applicable). */
    readonly map: RosettaMap;
    /** Detected or user-supplied app name. */
    readonly app: string;
    /** Detected or user-supplied version label. */
    readonly version: string;
    /**
     * Detected or user-supplied authoritative `version_code`
     * (PackageInfo.versionCode / longVersionCode) — the primary, O(1) map
     * selection key (RFC 0001 Decision 3). Undefined when neither supplied
     * nor auto-detectable (selection then fell back to the version label).
     */
    readonly versionCode?: number;
    /** Effective failure policy. */
    readonly failurePolicy: FailurePolicy;
    /** Whether the attach-time health check has passed. */
    readonly healthy: boolean;
}
