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
import type { FailurePolicy, Session, VersionMatch } from '../types/session.js';
import { buildSession } from './build-session.js';
import type { InternalSessionOptions } from './session-options.js';
import { isRegistry } from './version-match.js';

export type { InternalSessionOptions } from './session-options.js';

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
