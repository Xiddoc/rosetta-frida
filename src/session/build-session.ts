/**
 * `buildSession` — the session construction pipeline.
 *
 * `RosettaSession` used to do everything in a ~130-line constructor. This
 * module breaks that into small, individually-testable stages that each do
 * ONE thing:
 *
 *   detect → select(+version-verify) → signer-guard → health-check → resolver-build
 *
 * The fallible stages (`selectAndVerifyStage`, `runSignerGuard`,
 * `healthStage`) return a
 * value-or-typed-error result so they can be unit-tested without try/catch
 * plumbing; `buildSession` unwraps them (throwing the carried error) so the
 * public `createSession` contract — "throws a typed error on a bad map /
 * mismatch / failed strict health check" — is unchanged. The infallible
 * stages return plain values. The `RosettaSession` class is now a thin
 * holder that assigns the pipeline's output.
 *
 * Event ordering is preserved exactly: `detect`, then `map-load`, then
 * (optional) `signer-check`, then (optional) `health-check`.
 */

import {
    HealthCheckFailedError,
    MapRetractedError,
    MapVersionMismatchError,
    MissingSignerError,
    type RosettaError,
    SignerMismatchError,
} from '../errors.js';
import { EventBus } from '../diagnostics/event-bus.js';
import { appPrefixOf, createResolver } from '../resolver/index.js';
import type { MapSelectionKind } from '../types/events.js';
import type { RosettaMap } from '../types/map.js';
import type { Resolver } from '../types/resolver.js';
import type { FailurePolicy, VersionMatch } from '../types/session.js';
import { detectAppAndVersion } from './auto-detect.js';
import { runHealthCheck, DEFAULT_HEALTH_CHECK_THRESHOLD } from './health-check.js';
import { checkSigner, NoSignerReadableError, normalizeSignerHash } from './signer-detect.js';
import { pickMapForVersion } from './version-match.js';
import type { InternalSessionOptions } from './session.js';

/** A fallible stage's result: a value or a typed error to throw. */
export type StageResult<T> = { ok: true; value: T } | { ok: false; error: RosettaError };

/** The detected/overridden app identity. */
export interface ResolvedDetection {
    app: string;
    version: string;
    versionCode?: number;
    source: 'auto' | 'override';
}

/** Everything `buildSession` computes, assigned onto the session value holder. */
export interface SessionState {
    map: RosettaMap;
    app: string;
    version: string;
    versionCode?: number;
    failurePolicy: FailurePolicy;
    versionMatch: VersionMatch;
    healthy: boolean;
    events: EventBus;
    resolver: Resolver;
}

// ---------------------------------------------------------------------------
// Stage 1 — detect
// ---------------------------------------------------------------------------

/**
 * Resolve `(app, version[, versionCode])`: explicit overrides win;
 * otherwise run the in-process auto-detect chain (user fields still
 * override the detected ones). Pure given its injected Java API.
 */
export function detectStage(options: InternalSessionOptions): ResolvedDetection {
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

// ---------------------------------------------------------------------------
// Stage 2 — select + version-verify
// ---------------------------------------------------------------------------

/**
 * Decide whether a picked map is acceptable for the running build. When a
 * version *code* was detected it is authoritative (RFC 0001 Decision 3);
 * otherwise fall back to version-*label* equality.
 *
 * Any non-`'exact'` `selectionKind` (a `'nearest'` / `'code-range'` /
 * `'label-range'` pick) is an explicit opt-in fallback and is accepted within
 * its tier even when its `version_code` / label differs from the detected one
 * — that is the whole purpose of the opt-in. The distinct kind (rather than a
 * single `fuzzy` boolean) is what is threaded onward so callers and events can
 * tell a deliberate far-range pick apart from a nearest guess (issue #22).
 */
export function isVersionAcceptable(
    mapVersionCode: number,
    detectedVersion: string,
    detectedVersionCode: number | undefined,
    mapVersion: string,
    selectionKind: MapSelectionKind,
): boolean {
    const approximate = selectionKind !== 'exact';
    if (detectedVersionCode !== undefined) {
        if (mapVersionCode === detectedVersionCode) return true;
        return approximate;
    }
    if (mapVersion === detectedVersion) return true;
    return approximate;
}

/** The select-stage output: the chosen map plus how it was selected. */
export interface SelectedMap {
    map: RosettaMap;
    selectionKind: MapSelectionKind;
}

/**
 * Pick the map for the detected build and verify its `(app, version)`
 * matches. Returns the chosen map plus its `selectionKind`, or a
 * `MapVersionMismatchError` to throw.
 */
export function selectAndVerifyStage(
    options: InternalSessionOptions,
    detection: ResolvedDetection,
    versionMatch: VersionMatch,
): StageResult<SelectedMap> {
    const picked = pickMapForVersion(options.map, {
        version: detection.version,
        versionCode: detection.versionCode,
        versionMatch,
    });
    const map = picked.map;
    const selectionKind = picked.fuzzyKind;

    if (map.app !== detection.app) {
        return {
            ok: false,
            error: new MapVersionMismatchError(
                `rosetta-frida: loaded map is for ${map.app}@${map.version} but the running process is ${detection.app}@${detection.version}.`,
                detection.app,
                detection.version,
                map.app,
                map.version,
            ),
        };
    }

    if (
        !isVersionAcceptable(
            map.version_code,
            detection.version,
            detection.versionCode,
            map.version,
            selectionKind,
        )
    ) {
        const detectedLabel =
            detection.versionCode === undefined
                ? detection.version
                : `${detection.version} (code ${detection.versionCode})`;
        const mapLabel = `${map.version} (code ${map.version_code})`;
        return {
            ok: false,
            error: new MapVersionMismatchError(
                `rosetta-frida: loaded map is for ${map.app}@${mapLabel} but the running process is ${detection.app}@${detectedLabel}. Provide a map for ${detectedLabel} or pass versionMatch: 'fuzzy'.`,
                detection.app,
                detection.version,
                map.app,
                map.version,
            ),
        };
    }

    return { ok: true, value: { map, selectionKind } };
}

// ---------------------------------------------------------------------------
// Stage 2.5 — lifecycle status gate
// ---------------------------------------------------------------------------

/**
 * Enforce the map's lifecycle `status` (#40). Runs immediately after
 * selection so a withdrawn map is refused before its names are probed:
 *
 *   - `'active'` (or absent): no-op, no event.
 *   - `'superseded'`: emit a `map-status` WARNING event and proceed (the
 *     map still loads — it is merely out of date).
 *   - `'retracted'`: emit a `map-status` event (so the reason is observable)
 *     and FAIL CLOSED with `MapRetractedError`.
 */
export function statusStage(map: RosettaMap, events: EventBus): StageResult<void> {
    const status = map.status;
    if (status === undefined || status === 'active') return { ok: true, value: undefined };

    const event = {
        type: 'map-status' as const,
        status,
        app: map.app,
        version: map.version,
        ...(map.superseded_by !== undefined ? { supersededBy: map.superseded_by } : {}),
    };
    events.emit(event);

    if (status === 'retracted') {
        const supersededClause =
            map.superseded_by !== undefined
                ? ` It was superseded by version_code ${map.superseded_by}; load that map instead.`
                : '';
        return {
            ok: false,
            error: new MapRetractedError(
                `rosetta-frida: refusing to load the map for ${map.app}@${map.version} — it is ` +
                    `marked status: 'retracted' (withdrawn).${supersededClause} ` +
                    'A retracted map is known-bad and cannot be applied; re-emit or pick a ' +
                    'non-retracted map.',
                map.app,
                map.version,
                map.superseded_by,
            ),
        };
    }

    // 'superseded' — warn but proceed.
    return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Stage 3 — signer guard
// ---------------------------------------------------------------------------

/**
 * Run the signing-certificate authenticity guard for the active map.
 *
 * No-op (returns `ok` with nothing emitted) when the map has no
 * `signer_sha256` or when `enforceSigner: false`. Otherwise reads the live
 * app's signer(s), emits a `signer-check` event, and FAILS CLOSED: the
 * three failure modes mirror the Kotlin `SignerGuard.verify` taxonomy
 * (malformed map hash → `MalformedSignerError` propagated from
 * `checkSigner`; valid hash but no readable live signer →
 * `MissingSignerError`; valid hash, signers present, none matches →
 * `SignerMismatchError`). An app may carry multiple signers; a match on
 * ANY one is accepted.
 */
export function runSignerGuard(
    map: RosettaMap,
    app: string,
    options: InternalSessionOptions,
    events: EventBus,
): StageResult<void> {
    const expected = map.signer_sha256;
    if (expected === undefined || expected === null) return { ok: true, value: undefined };
    if (options.enforceSigner === false) return { ok: true, value: undefined };

    let result;
    try {
        result = checkSigner(expected, options.signerJavaApi);
    } catch (e) {
        // A map that demands a signer the live app can't produce must fail
        // closed with MissingSignerError. Other errors — notably the
        // MalformedSignerError for an ill-formed map hash — propagate.
        if (e instanceof NoSignerReadableError) {
            const expectedLabel = (Array.isArray(expected) ? expected : [expected])
                .map(normalizeSignerHash)
                .sort()
                .join(', ');
            return {
                ok: false,
                error: new MissingSignerError(
                    `rosetta-frida: the loaded map (${map.app}@${map.version}) expects ` +
                        `signing-certificate SHA-256 ${expectedLabel}, but the running app ` +
                        `${app} exposed no readable signing certificate. ` +
                        'Refusing to apply a map whose signer guard cannot be satisfied ' +
                        '(pass enforceSigner: false to override).',
                    expectedLabel,
                ),
            };
        }
        throw e;
    }

    events.emit({
        type: 'signer-check',
        passed: result.passed,
        app,
        expected: result.expected,
        actual: result.actual,
        source: result.source,
    });

    if (!result.passed) {
        return {
            ok: false,
            error: new SignerMismatchError(
                `rosetta-frida: signer mismatch for ${app} — the loaded map (${map.app}@${map.version}) expects signing-certificate SHA-256 ${result.expected}, ` +
                    `but the running app is signed by [${result.actual.join(', ')}]. ` +
                    'Refusing to apply a map to an app it was not captured for (pass enforceSigner: false to override).',
                app,
                result.expected,
                result.actual,
            ),
        };
    }

    return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Stage 4 — health check
// ---------------------------------------------------------------------------

/**
 * Run the attach-time health check (unless skipped), emit its event, and
 * return whether the session is healthy — or a `HealthCheckFailedError` to
 * throw when the check fails under strict policy.
 */
export function healthStage(
    map: RosettaMap,
    app: string,
    options: InternalSessionOptions,
    failurePolicy: FailurePolicy,
    events: EventBus,
): StageResult<boolean> {
    if (options.skipHealthCheck === true) {
        return { ok: true, value: true };
    }
    const threshold = options.healthCheckThreshold ?? DEFAULT_HEALTH_CHECK_THRESHOLD;
    const targetPolicy = options.targetPolicy ?? {};
    const appPrefix = appPrefixOf(app, targetPolicy);
    const result = runHealthCheck({
        map,
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
    if (!result.passed && failurePolicy === 'strict') {
        return {
            ok: false,
            error: new HealthCheckFailedError(
                `rosetta-frida: health check failed for ${map.app}@${map.version} — rate=${(result.rate * 100).toFixed(1)}% threshold=${(result.threshold * 100).toFixed(1)}%, ${result.failedEntries.length} entry/entries did not resolve.`,
                result.rate,
                result.threshold,
                result.failedEntries,
            ),
        };
    }
    return { ok: true, value: result.passed };
}

// ---------------------------------------------------------------------------
// Stage 5 — resolver build
// ---------------------------------------------------------------------------

/** Build the session-bound Resolver. */
export function resolverStage(
    map: RosettaMap,
    app: string,
    options: InternalSessionOptions,
    failurePolicy: FailurePolicy,
    events: EventBus,
): Resolver {
    return createResolver(map, {
        events,
        failurePolicy,
        targetPolicy: options.targetPolicy ?? {},
        appPackage: app,
    });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Unwrap a fallible stage result, throwing its typed error on failure. */
function unwrap<T>(result: StageResult<T>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

/**
 * Run the full pipeline and return the computed session state. Throws the
 * same typed errors the old constructor did, in the same order.
 */
export function buildSession(options: InternalSessionOptions): SessionState {
    const failurePolicy = options.failurePolicy ?? 'warn';
    // Per-session `versionMatch` wins; otherwise the typed config's
    // `versionMatching` default; otherwise 'exact' (fail-hard-by-default).
    // `pickMapForVersion` normalizes whichever form this is.
    const versionMatch: VersionMatch =
        options.versionMatch ?? options.config?.versionMatching ?? 'exact';

    const events = options.events ?? new EventBus();
    if (options.trace) events.setTrace(true);

    // 1. Detect.
    const detection = detectStage(options);
    events.emit({
        type: 'detect',
        app: detection.app,
        version: detection.version,
        source: detection.source,
    });

    // 2. Select + version-verify.
    const { map, selectionKind } = unwrap(selectAndVerifyStage(options, detection, versionMatch));

    // Emit a structured map-load now that we know what we picked. The
    // selectionKind makes the chosen tier visible (a far range pick is
    // distinguishable from a nearest-label guess, not a single fuzzy bit).
    events.emit({
        type: 'map-load',
        app: map.app,
        version: map.version,
        classCount: Object.keys(map.classes).length,
        schemaVersion: map.schema_version,
        selectionKind,
    });

    // 2.5 Lifecycle status gate: refuse a retracted map (fail-closed), warn
    //     on a superseded one. Runs before identity/health so a withdrawn map
    //     never gets probed.
    unwrap(statusStage(map, events));

    // 3. Signer-certificate authenticity guard (runs before the functional
    //    health check: identity gates a map before we probe its names).
    unwrap(runSignerGuard(map, detection.app, options, events));

    // 4. Health check.
    const healthy = unwrap(healthStage(map, detection.app, options, failurePolicy, events));

    // 5. Resolver.
    const resolver = resolverStage(map, detection.app, options, failurePolicy, events);

    const state: SessionState = {
        map,
        app: detection.app,
        version: detection.version,
        failurePolicy,
        versionMatch,
        healthy,
        events,
        resolver,
    };
    if (detection.versionCode !== undefined) state.versionCode = detection.versionCode;
    return state;
}
