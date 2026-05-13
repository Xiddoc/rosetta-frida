/**
 * Attach-time health check.
 *
 * Before user hooks run, verify the loaded map matches the running app:
 *
 *   1. For every mapped class, attempt `Java.use(obfName)`. Failed
 *      lookups mark the class as a failure.
 *   2. For AIDL stubs/callbacks with `aidl_descriptor`, additionally
 *      check `Klass.$aidlDescriptor` matches.
 *   3. For classes carrying `anchors`, verify each appears in
 *      `Klass.$anchorStrings`.
 *
 * The success rate (passing classes / total) is compared against a
 * configurable threshold (default 0.8). On failure, the session
 * decides what to do: `strict` failurePolicy → throw; `warn` → emit
 * a failure event but proceed.
 *
 * The Java runtime is injected so the check is unit-testable without
 * touching global state.
 */

import type { RosettaMap } from '../types/map.js';

/** Minimal Frida-shaped Java API used by the health check. */
export interface HealthCheckJavaApi {
    use(obfName: string): {
        readonly $aidlDescriptor?: string | null;
        readonly $anchorStrings?: readonly string[];
    };
}

/** Health-check input. */
export interface RunHealthCheckOptions {
    /** The map being checked. */
    map: RosettaMap;
    /**
     * Fraction of classes that must pass for the check itself to pass.
     * Defaults to 0.8.
     */
    threshold?: number;
    /** Injectable Java runtime. Defaults to the global `Java`. */
    javaApi?: HealthCheckJavaApi;
}

/** Health-check result. */
export interface HealthCheckResult {
    /** True iff `rate >= threshold`. */
    passed: boolean;
    /** Fraction of mapped classes that passed. */
    rate: number;
    /** Configured threshold. */
    threshold: number;
    /** Real names that failed (Java.use error, descriptor mismatch, missing anchor). */
    failedEntries: readonly string[];
    /** Total mapped classes considered. */
    total: number;
}

/** Default acceptance threshold. */
export const DEFAULT_HEALTH_CHECK_THRESHOLD = 0.8;

/**
 * Run the attach-time health check.
 *
 * The function never throws — it returns a structured result. The
 * caller (the Session) is responsible for deciding whether to emit an
 * event, log a warning, or throw `HealthCheckFailedError` based on
 * the failure policy.
 */
export function runHealthCheck(options: RunHealthCheckOptions): HealthCheckResult {
    const { map } = options;
    const threshold = options.threshold ?? DEFAULT_HEALTH_CHECK_THRESHOLD;
    const javaApi = options.javaApi ?? (globalThis as { Java?: HealthCheckJavaApi }).Java ?? null;

    if (!javaApi) {
        // Without a Java runtime, no entries can be verified.
        const entries = Object.keys(map.classes);
        return {
            passed: entries.length === 0,
            rate: entries.length === 0 ? 1 : 0,
            threshold,
            failedEntries: entries,
            total: entries.length,
        };
    }

    const failedEntries: string[] = [];
    const entries = Object.entries(map.classes);
    let passing = 0;

    for (const [realName, entry] of entries) {
        let ok: boolean;
        try {
            const klass = javaApi.use(entry.obfuscated);
            ok = checkDescriptor(entry.aidl_descriptor, klass.$aidlDescriptor);
            if (ok) {
                ok = checkAnchors(entry.anchors, klass.$anchorStrings);
            }
        } catch {
            ok = false;
        }
        if (ok) {
            passing += 1;
        } else {
            failedEntries.push(realName);
        }
    }

    if (entries.length === 0) {
        // Empty map: nothing to check; treat as trivially passing.
        return {
            passed: true,
            rate: 1,
            threshold,
            failedEntries: [],
            total: 0,
        };
    }

    const rate = passing / entries.length;
    return {
        passed: rate >= threshold,
        rate,
        threshold,
        failedEntries,
        total: entries.length,
    };
}

/** Verify the AIDL descriptor matches, if the map specifies one. */
function checkDescriptor(expected: string | undefined, actual: string | null | undefined): boolean {
    if (expected === undefined) return true;
    return actual === expected;
}

/** Verify every anchor string is present on the class. */
function checkAnchors(
    expected: readonly string[] | undefined,
    actual: readonly string[] | undefined,
): boolean {
    if (expected === undefined || expected.length === 0) return true;
    const actualSet = new Set(actual ?? []);
    for (const anchor of expected) {
        if (!actualSet.has(anchor)) return false;
    }
    return true;
}
