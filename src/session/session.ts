/**
 * `RosettaSession` — the runtime lifecycle handle returned by
 * `createSession(...)` (and the tier-1 / tier-2 / tier-3 user-facing
 * `rosetta.session(...)`).
 *
 * The class is a thin VALUE HOLDER: all construction work lives in the
 * `buildSession(...)` pipeline (`build-session.ts`), a sequence of small,
 * individually-tested stages:
 *
 *   detect → select(+version-verify) → signer-guard → health-check → resolver-build
 *
 * Responsibilities (per design §6), now realised stage-by-stage there:
 *   1. Resolve `(app, version)`: prefer user-supplied; otherwise auto-detect.
 *   2. Pick the right map from a registry; honour `versionMatch: 'fuzzy'`.
 *   3. Verify the picked map's `(app, version)` — mismatch →
 *      `MapVersionMismatchError`.
 *   3.5. Enforce the signing-certificate guard (`signer_sha256`), fail-closed.
 *   4. Run the attach-time health check (strict → throw; warn → emit + proceed).
 *   5. Expose a Resolver bound to the chosen map + the session's EventBus.
 *
 * The session takes a `RosettaMap` or `RosettaMapRegistry` directly — path
 * loading is the user's responsibility via the async `loadMap`.
 */

import type { EventBus } from '../log.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import type { FailurePolicy, Session, SessionOptions, VersionMatch } from '../types/session.js';
import type { AutoDetectJavaApi } from './auto-detect.js';
import { buildSession } from './build-session.js';
import type { HealthCheckJavaApi } from './health-check.js';
import type { SignerJavaApi } from './signer-detect.js';
import { isRegistry } from './version-match.js';

/**
 * Internal-only extension of `SessionOptions` that lets the session accept
 * injected Java runtimes for tests. The public `SessionOptions` locked
 * contract doesn't expose these. The `buildSession` pipeline imports this
 * as a TYPE only, so there is no runtime import cycle with this module.
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
    /**
     * Public — detected authoritative `version_code`, when known
     * (PackageInfo.versionCode / longVersionCode). Undefined if neither was
     * supplied nor auto-detectable.
     */
    public readonly versionCode?: number;
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
        const state = buildSession(options);
        this.map = state.map;
        this.app = state.app;
        this.version = state.version;
        if (state.versionCode !== undefined) this.versionCode = state.versionCode;
        this.failurePolicy = state.failurePolicy;
        this.versionMatch = state.versionMatch;
        this.healthy = state.healthy;
        this.events = state.events;
        this.resolver = state.resolver;
    }
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
