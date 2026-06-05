/**
 * `RosettaSession` — the runtime lifecycle handle returned by
 * `createSession(...)` (and the tier-1 / tier-2 / tier-3 user-facing
 * `rosetta.session(...)`).
 *
 * Responsibilities (per design §6):
 *   1. Resolve `(app, version)`: prefer user-supplied; otherwise run
 *      `detectAppAndVersion` against the in-process PackageManager.
 *   2. If the user passed a `RosettaMapRegistry`, pick the right map
 *      for the resolved version. Honour `versionMatch: 'fuzzy'`
 *      fallback (off by default).
 *   3. Verify the picked map's `(app, version)` matches the resolved
 *      `(app, version)`. Mismatch → `MapVersionMismatchError`.
 *   4. Run the attach-time health check unless `skipHealthCheck` is
 *      set. In `strict` mode a failed check throws
 *      `HealthCheckFailedError`; in `warn` mode (default) it still
 *      emits a `health-check` event with `passed: false` and proceeds.
 *   5. Expose a Resolver bound to the chosen map + the session's
 *      EventBus. Tier-1 / tier-2 / tier-3 callers consume that.
 *
 * The session takes a `RosettaMap` or `RosettaMapRegistry` directly
 * — path loading is the user's responsibility via the async `loadMap`.
 * Document this in the JSDoc on `createSession`.
 */

import {
    HealthCheckFailedError,
    MapVersionMismatchError,
    MissingSignerError,
    SignerMismatchError,
} from '../errors.js';
import { EventBus } from '../log.js';
import { appPrefixOf, createResolver } from '../resolver/index.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import type { FailurePolicy, Session, SessionOptions, VersionMatch } from '../types/session.js';
import { detectAppAndVersion, type AutoDetectJavaApi } from './auto-detect.js';
import {
    runHealthCheck,
    DEFAULT_HEALTH_CHECK_THRESHOLD,
    type HealthCheckJavaApi,
} from './health-check.js';
import {
    checkSigner,
    NoSignerReadableError,
    normalizeSignerHash,
    type SignerJavaApi,
} from './signer-detect.js';
import { isRegistry, pickMapForVersion } from './version-match.js';

/**
 * Internal-only extension of `SessionOptions` that lets the session
 * accept injected Java runtimes for tests. The public `SessionOptions`
 * locked contract doesn't expose these.
 */
export interface InternalSessionOptions extends SessionOptions {
    /** Test-only: inject the Java API used by auto-detect. */
    autoDetectJavaApi?: AutoDetectJavaApi;
    /** Test-only: inject the Java API used by the health check. */
    healthCheckJavaApi?: HealthCheckJavaApi;
    /** Test-only: inject the Java API used by the signer-certificate check. */
    signerJavaApi?: SignerJavaApi;
    /**
     * Test-only: provide an explicit EventBus. If omitted, the session
     * creates its own session-local bus.
     */
    events?: EventBus;
}

export class RosettaSession implements Session {
    /** Public — the active, version-resolved map. */
    public readonly map: RosettaMap;
    /** Public — detected or user-supplied app. */
    public readonly app: string;
    /** Public — detected or user-supplied version. */
    public readonly version: string;
    /** Public — effective failure policy. */
    public readonly failurePolicy: FailurePolicy;
    /** Public — set after construction completes successfully. */
    public readonly healthy: boolean;

    /** Effective version-match mode. */
    public readonly versionMatch: VersionMatch;

    /** The session-local diagnostic bus. */
    public readonly events: EventBus;

    /** The bound Resolver for this session. */
    public readonly resolver: Resolver;

    constructor(options: InternalSessionOptions) {
        this.failurePolicy = options.failurePolicy ?? 'warn';
        this.versionMatch = options.versionMatch ?? 'exact';

        const events = options.events ?? new EventBus();
        if (options.trace) {
            events.setTrace(true);
        }
        this.events = events;

        // 1. Determine app + version (user override OR auto-detect).
        const detection = resolveAppAndVersion(options);
        this.app = detection.app;
        this.version = detection.version;
        events.emit({
            type: 'detect',
            app: detection.app,
            version: detection.version,
            source: detection.source,
        });

        // 2. Pick the right map from the registry (or take the single map).
        //    version_code, when known, is the authoritative selection key.
        const picked = pickMapForVersion(options.map, {
            version: detection.version,
            versionCode: detection.versionCode,
            versionMatch: this.versionMatch,
        });
        this.map = picked.map;

        // 3. Verify the picked map's (app, version) match the detected ones.
        if (this.map.app !== detection.app) {
            throw new MapVersionMismatchError(
                `rosetta-frida: loaded map is for ${this.map.app}@${this.map.version} but the running process is ${detection.app}@${detection.version}.`,
                detection.app,
                detection.version,
                this.map.app,
                this.map.version,
            );
        }
        if (
            !this.isVersionAcceptable(
                this.map.version_code,
                detection.version,
                detection.versionCode,
                this.map.version,
                picked.fuzzy,
            )
        ) {
            const detectedLabel =
                detection.versionCode === undefined
                    ? detection.version
                    : `${detection.version} (code ${detection.versionCode})`;
            const mapLabel = `${this.map.version} (code ${this.map.version_code})`;
            throw new MapVersionMismatchError(
                `rosetta-frida: loaded map is for ${this.map.app}@${mapLabel} but the running process is ${detection.app}@${detectedLabel}. Provide a map for ${detectedLabel} or pass versionMatch: 'fuzzy'.`,
                detection.app,
                detection.version,
                this.map.app,
                this.map.version,
            );
        }

        // Emit a structured map-load now that we know what we picked.
        events.emit({
            type: 'map-load',
            app: this.map.app,
            version: this.map.version,
            classCount: Object.keys(this.map.classes).length,
            schemaVersion: this.map.schema_version,
        });

        // 3.5. Signer-certificate authenticity guard (RFC 0001 Decision 3).
        //      Runs after version selection but before the functional
        //      health check: identity/authenticity gates a map before we
        //      bother probing whether its names resolve. Skipped when the
        //      map carries no `signer_sha256`, or when explicitly opted out
        //      via `enforceSigner: false`. When present + enforced it FAILS
        //      CLOSED — a mismatch throws `SignerMismatchError`.
        this.enforceSignerGuard(options, events);

        // 4. Health check.
        //    The target-namespace guard (RFC 0001 C1) is threaded in here too:
        //    the health check loads every mapped class via `Java.use`, so it
        //    must funnel each raw obf name through the SAME guard the resolver
        //    uses, with the SAME policy + app prefix — otherwise a malicious
        //    map entry (e.g. obfuscated: 'java.lang.Runtime') would be loaded
        //    and <clinit>-initialized at attach, bypassing the guard.
        const skip = options.skipHealthCheck === true;
        const threshold = options.healthCheckThreshold ?? DEFAULT_HEALTH_CHECK_THRESHOLD;
        const targetPolicy = options.targetPolicy ?? {};
        const appPrefix = appPrefixOf(this.app, targetPolicy);
        if (skip) {
            this.healthy = true;
        } else {
            const result = runHealthCheck({
                map: this.map,
                threshold,
                javaApi: options.healthCheckJavaApi,
                targetPolicy,
                appPrefix,
            });
            events.emit({
                type: 'health-check',
                passed: result.passed,
                rate: result.rate,
                failedEntries: result.failedEntries,
                threshold: result.threshold,
            });
            if (!result.passed && this.failurePolicy === 'strict') {
                throw new HealthCheckFailedError(
                    `rosetta-frida: health check failed for ${this.map.app}@${this.map.version} — rate=${(result.rate * 100).toFixed(1)}% threshold=${(result.threshold * 100).toFixed(1)}%, ${result.failedEntries.length} entry/entries did not resolve.`,
                    result.rate,
                    result.threshold,
                    result.failedEntries,
                );
            }
            this.healthy = result.passed;
        }

        // 5. Build the resolver, bound to the session bus + policy.
        //    The target-namespace guard (RFC 0001 C1) is threaded here: the
        //    app's own prefix is derived from the detected/resolved app
        //    package, and the policy is the user's (or the fail-closed
        //    default when omitted).
        this.resolver = createResolver(this.map, {
            events: this.events,
            failurePolicy: this.failurePolicy,
            targetPolicy,
            appPackage: this.app,
        });
    }

    /**
     * Run the signing-certificate authenticity guard for the active map.
     *
     * No-op (and emits nothing) when the map has no `signer_sha256` or when
     * `enforceSigner: false` (the Frida-idiomatic equivalent of the Kotlin
     * client's unverified construction path). Otherwise reads the live
     * app's signer(s) in-process, emits a structured `signer-check` event,
     * and FAILS CLOSED. The three failure modes mirror the Kotlin
     * `SignerGuard.verify` taxonomy:
     *
     *   - the map's own `signer_sha256` is ill-formed (not 64 hex after
     *     normalization) → `MalformedSignerError` (raised by `checkSigner`);
     *   - the map's hash is valid but the live app exposes no readable
     *     signer → `MissingSignerError`;
     *   - the map's hash is valid, signers are present, but none matches →
     *     `SignerMismatchError`.
     *
     * An app may carry multiple signers (key-rotation lineage / multi-signer
     * builds); a match on ANY one is accepted.
     */
    private enforceSignerGuard(options: InternalSessionOptions, events: EventBus): void {
        const expected = this.map.signer_sha256;
        if (expected === undefined || expected === null) return;
        if (options.enforceSigner === false) return;

        let result;
        try {
            result = checkSigner(expected, options.signerJavaApi);
        } catch (e) {
            // A map that demands a signer the live app can't produce must
            // fail closed with the typed MissingSignerError (carrying the
            // map's normalized expected hash). Other errors — notably the
            // MalformedSignerError for an ill-formed map hash — propagate.
            if (e instanceof NoSignerReadableError) {
                throw new MissingSignerError(
                    `rosetta-frida: the loaded map (${this.map.app}@${this.map.version}) expects ` +
                        `signing-certificate SHA-256 ${normalizeSignerHash(expected)}, but the running app ` +
                        `${this.app} exposed no readable signing certificate. ` +
                        'Refusing to apply a map whose signer guard cannot be satisfied ' +
                        '(pass enforceSigner: false to override).',
                    normalizeSignerHash(expected),
                );
            }
            throw e;
        }
        events.emit({
            type: 'signer-check',
            passed: result.passed,
            app: this.app,
            expected: result.expected,
            actual: result.actual,
            source: result.source,
        });
        if (!result.passed) {
            throw new SignerMismatchError(
                `rosetta-frida: signer mismatch for ${this.app} — the loaded map (${this.map.app}@${this.map.version}) expects signing-certificate SHA-256 ${result.expected}, ` +
                    `but the running app is signed by [${result.actual.join(', ')}]. ` +
                    'Refusing to apply a map to an app it was not captured for (pass enforceSigner: false to override).',
                this.app,
                result.expected,
                result.actual,
            );
        }
    }

    /**
     * Decide whether the picked map is acceptable for the running build.
     *
     * When a version *code* was detected it is authoritative: the map's
     * `version_code` must equal it (the RFC 0001 Decision 3 contract),
     * unless the user opted into a fuzzy pick. Otherwise we fall back to
     * the legacy version-*label* equality check (or fuzzy opt-in).
     */
    private isVersionAcceptable(
        mapVersionCode: number,
        detectedVersion: string,
        detectedVersionCode: number | undefined,
        mapVersion: string,
        fuzzy: boolean,
    ): boolean {
        if (detectedVersionCode !== undefined) {
            if (mapVersionCode === detectedVersionCode) return true;
            return fuzzy;
        }
        if (mapVersion === detectedVersion) return true;
        return fuzzy;
    }
}

interface ResolvedDetection {
    app: string;
    version: string;
    versionCode?: number;
    source: 'auto' | 'override';
}

function resolveAppAndVersion(options: InternalSessionOptions): ResolvedDetection {
    // If BOTH app and version are explicitly supplied, no auto-detect needed.
    if (options.app !== undefined && options.version !== undefined) {
        const overridden: ResolvedDetection = {
            app: options.app,
            version: options.version,
            source: 'override',
        };
        if (options.versionCode !== undefined) overridden.versionCode = options.versionCode;
        return overridden;
    }
    // Otherwise run the in-process chain; user-supplied fields then
    // override the detected ones (e.g. force a specific version for tests).
    const detected = detectAppAndVersion(options.autoDetectJavaApi);
    const resolved: ResolvedDetection = {
        app: options.app ?? detected.app,
        version: options.version ?? detected.version,
        source: options.app !== undefined || options.version !== undefined ? 'override' : 'auto',
    };
    const versionCode = options.versionCode ?? detected.versionCode;
    if (versionCode !== undefined) resolved.versionCode = versionCode;
    return resolved;
}

/**
 * Returns a `RosettaSession` configured per the supplied options.
 *
 * The session accepts an in-memory `RosettaMap` or a `RosettaMapRegistry`
 * — NOT a filesystem path. Use `loadMap(path)` (async) up-front and
 * await the result before constructing a session.
 */
export function createSession(options: InternalSessionOptions): RosettaSession {
    return new RosettaSession(options);
}

// Re-export for callers that want to type-narrow the input themselves.
export { isRegistry };
export type { RosettaMap, RosettaMapRegistry };
