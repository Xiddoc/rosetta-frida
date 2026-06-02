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

/** User-facing options for `rosetta.session(...)`. */
export interface SessionOptions {
    /**
     * The map (or registry of maps) to use. Required.
     *
     * Single-map: rosetta picks based on the detected version, error if mismatch.
     * Registry: rosetta picks the right per-version map; error if no match.
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
}

/** The handle returned from `rosetta.session(...)`. */
export interface Session {
    /** The active map (resolved from registry if applicable). */
    readonly map: RosettaMap;
    /** Detected or user-supplied app name. */
    readonly app: string;
    /** Detected or user-supplied version. */
    readonly version: string;
    /** Effective failure policy. */
    readonly failurePolicy: FailurePolicy;
    /** Whether the attach-time health check has passed. */
    readonly healthy: boolean;
}
